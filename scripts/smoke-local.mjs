import '../config.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import pg from 'pg';
import bcrypt from 'bcryptjs';
import Stripe from 'stripe';
import { stripeDeploymentId } from '../services/stripeService.mjs';

// This opt-in smoke test creates only isolated local users and Stripe TEST
// objects. Existing user/subscription rows are fingerprinted before and after.
const args = new Set(process.argv.slice(2));
if (!args.has('--live-stripe')) {
  console.log('Usage: node scripts/smoke-local.mjs --live-stripe [--resume]');
  console.log('Creates up to two local test accounts and Stripe TEST trials; never sends email.');
  process.exit(0);
}

const root = fileURLToPath(new URL('../', import.meta.url));
const localDir = path.join(root, '.local');
const accountFile = path.join(localDir, 'test-accounts.json');
const reportFile = path.join(localDir, 'smoke-local-report.json');
const backend = new URL(process.env.BACKEND_URL || 'http://localhost:5000');
const loopback = value => ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(value);
assert(loopback(backend.hostname), 'Smoke test requires a loopback backend URL.');
assert(loopback(process.env.DB_HOST), 'Smoke test requires the existing local database.');
assert(!process.env.DATABASE_URL, 'Use the explicit local DB settings for this test.');
assert(process.env.STRIPE_TEST_MODE !== 'false', 'Stripe test mode must remain enabled.');
assert(/^(sk|rk)_test_/.test(process.env.STRIPE_SECRET_KEY || ''), 'A Stripe test key is required.');
assert(process.env.STRIPE_WEBHOOK_SECRET, 'Local Stripe CLI webhook signing secret is required.');
const deploymentId = stripeDeploymentId();
assert.equal(deploymentId, 'local', 'This smoke test requires the local Stripe deployment identity.');
assert.equal(spawnSync('git', ['check-ignore', '--quiet', '.local/test-accounts.json'], { cwd: root }).status, 0,
  'Test credentials must be ignored by Git.');

let registry;
try {
  registry = JSON.parse(await fs.readFile(accountFile, 'utf8'));
  assert(args.has('--resume'), 'A test fixture already exists; use --resume to reuse its accounts.');
  assert.equal(registry.kind, 'homework-help-ai-local-test');
  assert(registry.accounts.length <= 2);
  assert(registry.accounts.every(account => /^local-smoke-[a-z0-9-]+@example\.invalid$/.test(account.email)));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  registry = { kind: 'homework-help-ai-local-test', runId: crypto.randomBytes(6).toString('hex'),
    createdAt: new Date().toISOString(), accounts: [] };
}

const backupNames = (await fs.readdir(path.join(root, 'backups'))).filter(name => name.endsWith('.dump'));
assert(backupNames.length > 0, 'Create a database backup before running the integration test.');
assert((await Promise.all(backupNames.map(name => fs.stat(path.join(root, 'backups', name))))).some(stat => stat.size > 0),
  'A nonempty database backup is required.');
await fs.mkdir(localDir, { recursive: true });
const artifactDir = path.join(localDir, 'smoke-local', registry.runId);
await fs.mkdir(artifactDir, { recursive: true });
const saveAccounts = () => fs.writeFile(accountFile, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { timeout: 20000, maxNetworkRetries: 1 });
const db = new pg.Client({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT),
  user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
  connectionTimeoutMillis: 10000, query_timeout: 10000 });
const report = { runId: registry.runId, startedAt: new Date().toISOString(), checks: [], passed: false };
const createdSubscriptions = new Set();
const openedCheckouts = new Set();
const tokens = new Map();
let step = 'preflight';
let baseline;
let success = false;

function check(name, detail = {}) {
  report.checks.push({ name, passed: true, ...detail });
  console.log(JSON.stringify({ check: name, passed: true }));
}

function testObject(object) {
  assert.equal(object.livemode, false, 'A returned Stripe object is not in test mode.');
  return object;
}

async function http(route, { token, method = 'GET', body, raw, headers = {} } = {}) {
  const response = await fetch(new URL(route, backend), {
    method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined || raw !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const data = await response.json().catch(() => null);
  return { status: response.status, data };
}

async function eventually(name, probe, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw Object.assign(new Error(`Timed out: ${name}`), { code: 'LOCAL_SMOKE_TIMEOUT' });
}

async function fingerprint() {
  const ids = registry.accounts.map(account => account.id);
  const result = {};
  for (const [table, order] of [['users', 'user_id'], ['subscriptions', 'id']]) {
    const { rows } = await db.query(`SELECT count(*)::int AS count,
      COALESCE(jsonb_agg(to_jsonb(t) ORDER BY ${order}), '[]'::jsonb) AS records
      FROM ${table} AS t WHERE NOT (user_id = ANY($1::int[]))`, [ids]);
    result[table] = { count: rows[0].count,
      hash: crypto.createHash('sha256').update(JSON.stringify(rows[0].records)).digest('hex') };
  }
  return result;
}

async function account(index) {
  if (registry.accounts[index]) {
    const fixture = registry.accounts[index];
    const existing = await db.query('SELECT user_id, email, nickname FROM users WHERE user_id = $1', [fixture.id]);
    assert.equal(existing.rows[0]?.email, fixture.email, 'Saved fixture no longer matches the local database.');
    assert.equal(existing.rows[0]?.nickname, `Local smoke ${registry.runId} ${index + 1}`);
    return fixture;
  }
  assert(registry.accounts.length < 2, 'Only two fixture users are allowed.');
  const email = `local-smoke-${registry.runId}-${index + 1}@example.invalid`;
  const password = crypto.randomBytes(18).toString('base64url');
  const hash = await bcrypt.hash(password, 10);
  const { rows } = await db.query(`INSERT INTO users (email, password, nickname, language, is_email_confirmed)
    VALUES ($1, $2, $3, 'en', TRUE) RETURNING user_id`, [email, hash, `Local smoke ${registry.runId} ${index + 1}`]);
  const fixture = { id: rows[0].user_id, email, password, purpose: index === 0 ? 'ended integration trial' : 'local seven-day demo trial' };
  registry.accounts.push(fixture);
  await saveAccounts();
  return fixture;
}

async function login(fixture) {
  const result = await http('/api/login/login', { method: 'POST', body: { email: fixture.email, password: fixture.password } });
  assert.equal(result.status, 200, 'Fixture login failed.');
  assert(result.data.token, 'Login did not return a token.');
  tokens.set(fixture.id, result.data.token);
}

async function state(fixture) {
  const result = await http('/api/user/status', { token: tokens.get(fixture.id) });
  assert.equal(result.status, 200, 'User status request failed.');
  return result.data.user;
}

async function trial(fixture) {
  if (!fixture.customerId) {
    const customer = testObject(await stripe.customers.create({ name: 'Local integration test fixture',
      metadata: { app: 'homework-help-ai', deployment_id: deploymentId, local_smoke_run: registry.runId, user_id: String(fixture.id) } }));
    fixture.customerId = customer.id;
    await saveAccounts();
  } else {
    const customer = testObject(await stripe.customers.retrieve(fixture.customerId));
    assert.equal(customer.metadata?.local_smoke_run, registry.runId, 'Customer is not owned by this fixture.');
  }
  if (fixture.subscriptionId) {
    const prior = testObject(await stripe.subscriptions.retrieve(fixture.subscriptionId));
    assert.equal(prior.metadata?.local_smoke_run, registry.runId, 'Subscription is not owned by this fixture.');
    assert.equal(prior.metadata?.deployment_id, deploymentId,
      'This legacy fixture predates deployment isolation. Preserve it and use fresh test accounts; do not claim its subscription.');
    if (prior.status === 'trialing') return prior;
  }
  const subscription = testObject(await stripe.subscriptions.create({ customer: fixture.customerId,
    items: [{ price: process.env.STRIPE_PRICE_ID }], trial_period_days: 7,
    trial_settings: { end_behavior: { missing_payment_method: 'cancel' } },
    metadata: { app: 'homework-help-ai', deployment_id: deploymentId, local_smoke_run: registry.runId, user_id: String(fixture.id) },
  }, { idempotencyKey: `local-smoke-${registry.runId}-${fixture.id}-${Date.now()}` }));
  createdSubscriptions.add(subscription.id);
  fixture.subscriptionId = subscription.id;
  fixture.trialEndsAt = new Date(subscription.trial_end * 1000).toISOString();
  await saveAccounts();
  assert.equal(subscription.status, 'trialing');
  return subscription;
}

async function replay(event) {
  const raw = JSON.stringify(event);
  const signature = stripe.webhooks.generateTestHeaderString({ payload: raw, secret: process.env.STRIPE_WEBHOOK_SECRET });
  const result = await http('/api/payment/webhook', { method: 'POST', raw, headers: { 'stripe-signature': signature } });
  assert.equal(result.status, 200, 'Signed test webhook replay failed.');
}

async function expireCheckout(id) {
  const session = testObject(await stripe.checkout.sessions.retrieve(id));
  if (session.status === 'open') testObject(await stripe.checkout.sessions.expire(id));
  openedCheckouts.delete(id);
}

try {
  await db.connect();
  baseline = await fingerprint();
  report.originalRows = { users: baseline.users.count, subscriptions: baseline.subscriptions.count };
  const health = await http('/api/health');
  assert.equal(health.status, 200, 'Local API is not ready.');
  const price = testObject(await stripe.prices.retrieve(process.env.STRIPE_PRICE_ID));
  assert(price.active && price.type === 'recurring', 'The test subscription price is unavailable.');
  check('local_services_and_test_price');

  step = 'create_fixture_users_and_login';
  const user1 = await account(0);
  const user2 = await account(1);
  await login(user1); await login(user2);
  check(step, { fixtureCount: 2, emailSent: false });

  step = 'checkout_wiring';
  if (!(await state(user1)).subscriptionStatus || !['active', 'trialing'].includes((await state(user1)).subscriptionStatus)) {
    const checkout = await http('/api/payment/create-checkout-session', { token: tokens.get(user1.id), method: 'POST', body: { returnPath: '/account' } });
    assert.equal(checkout.status, 200, 'Local Checkout request failed.');
    const url = new URL(checkout.data.url);
    assert.equal(url.hostname, 'checkout.stripe.com');
    const id = url.pathname.split('/').find(part => part.startsWith('cs_test_'));
    assert(id, 'Checkout URL does not identify a test session.');
    openedCheckouts.add(id);
    registry.checkoutSessionIds = [...new Set([...(registry.checkoutSessionIds || []), id])];
    await saveAccounts();
    const session = testObject(await stripe.checkout.sessions.retrieve(id));
    assert.equal(session.client_reference_id, String(user1.id));
    await expireCheckout(id);
  }
  check(step);

  step = 'real_created_webhooks';
  const sub1 = await trial(user1);
  const sub2 = await trial(user2);
  await eventually('trial webhook user 1', async () => (await state(user1)).subscriptionStatus === 'trialing');
  await eventually('trial webhook user 2', async () => (await state(user2)).subscriptionStatus === 'trialing');
  check(step);

  step = 'cancel_and_restore_trial';
  const duplicate = await http('/api/payment/create-checkout-session', { token: tokens.get(user1.id), method: 'POST', body: {} });
  assert.equal(duplicate.status, 409, 'Duplicate subscription was not blocked.');
  const cancel = await http('/api/payment/cancel-subscription', { token: tokens.get(user1.id), method: 'POST' });
  assert.equal(cancel.status, 200, 'Cancel-at-period-end failed.');
  assert.equal((await state(user1)).cancelAtPeriodEnd, true);
  const resume = await http('/api/payment/reactivate-subscription', { token: tokens.get(user1.id), method: 'POST' });
  assert.equal(resume.status, 200, 'Subscription restoration failed.');
  assert.equal((await state(user1)).cancelAtPeriodEnd, false);
  assert.equal((await state(user1)).subscriptionStatus, 'trialing');
  check(step);

  step = 'export_documents_and_ownership';
  const markdown = '# 本地集成测试 / Local integration test\n\n解方程 Solve $2x + 3 = 7$: **$x = 2$**.\n\n$$\\lVert x \\rVert = 2$$\n\n| 项目 | Value |\n| --- | --- |\n| 答案 | 2 |\n\n```js\nconst fallback = value || 2;\n```\n';
  for (const format of ['docx', 'pdf']) {
    const queued = await http(`/api/export/${format}`, { token: tokens.get(user1.id), method: 'POST', body: { markdownText: markdown } });
    assert.equal(queued.status, 202, `${format} export was not queued.`);
    const jobId = queued.data.jobId;
    const foreign = await http(`/api/export/status/${jobId}`, { token: tokens.get(user2.id) });
    assert.equal(foreign.status, 404, 'Another user could inspect the export.');
    const result = await eventually(`${format} conversion`, async () => {
      const current = await http(`/api/export/status/${jobId}`, { token: tokens.get(user1.id) });
      assert.equal(current.status, 200);
      assert.notEqual(current.data.state, 'failed', `${format} conversion failed.`);
      return current.data.state === 'completed' ? current.data.result : null;
    }, 120000);
    assert(Date.parse(result.expiresAt) > Date.now(), 'Download expiry is invalid.');
    const download = new URL(result.downloadUrl);
    assert(loopback(download.hostname), 'Export URL is not local.');
    const response = await fetch(download, { signal: AbortSignal.timeout(20000) });
    assert.equal(response.status, 200, 'Signed export download failed.');
    const data = Buffer.from(await response.arrayBuffer());
    assert.equal(data.subarray(0, format === 'pdf' ? 5 : 2).toString(), format === 'pdf' ? '%PDF-' : 'PK');
    await fs.writeFile(path.join(artifactDir, `integration.${format}`), data);
    download.searchParams.set('signature', 'invalid');
    assert.equal((await fetch(download, { signal: AbortSignal.timeout(10000) })).status, 403, 'Tampered download was accepted.');
    check(`export_${format}`, { bytes: data.length, ownershipEnforced: true, signedDownload: true });
  }

  step = 'end_trial_and_replay_older_events';
  const events = await stripe.events.list({ type: 'customer.subscription.created', limit: 100 });
  const oldEvent = events.data.find(event => event.data.object.id === sub1.id);
  assert(oldEvent, 'The actual subscription-created event was not found.');
  testObject(oldEvent);
  testObject(await stripe.subscriptions.cancel(sub1.id));
  await eventually('canceled webhook', async () => (await state(user1)).subscriptionStatus === 'canceled');
  await replay(oldEvent); await replay(oldEvent);
  assert.equal((await state(user1)).subscriptionStatus, 'canceled', 'An old event restored a canceled trial.');
  for (const route of ['/api/export/docx', '/api/speech']) {
    const denied = await http(route, { token: tokens.get(user1.id), method: 'POST', body: { markdownText: markdown, text: 'Hello.' } });
    assert.equal(denied.status, 403, 'Ended subscription retained premium access.');
  }
  const badSignature = await http('/api/payment/webhook', { method: 'POST', body: oldEvent, headers: { 'stripe-signature': 'invalid' } });
  assert.equal(badSignature.status, 400);
  check(step);
  const demo = testObject(await stripe.subscriptions.retrieve(sub2.id));
  assert.equal(demo.status, 'trialing');
  assert.equal(demo.trial_settings?.end_behavior?.missing_payment_method, 'cancel');
  registry.accounts[0].status = 'canceled';
  registry.accounts[1].status = 'trialing';
  registry.accounts[1].trialEndsAt = new Date(demo.trial_end * 1000).toISOString();
  report.demoTrialRetained = true;
  success = true;
} catch (error) {
  report.failure = { step, type: error.name, code: error.code || 'LOCAL_SMOKE_FAILED' };
  console.log(JSON.stringify({ check: step, passed: false, errorType: error.name, errorCode: error.code || 'LOCAL_SMOKE_FAILED' }));
} finally {
  for (const id of openedCheckouts) {
    try { await expireCheckout(id); }
    catch (error) { report.checkoutCleanupFailed = true; }
  }
  if (!success) {
    report.canceledNewTestSubscriptions = 0;
    for (const id of createdSubscriptions) {
      try {
        const current = testObject(await stripe.subscriptions.retrieve(id));
        assert.equal(current.metadata?.local_smoke_run, registry.runId);
        if (current.status !== 'canceled') testObject(await stripe.subscriptions.cancel(id));
        report.canceledNewTestSubscriptions++;
      } catch { report.subscriptionCleanupFailed = true; }
    }
  }
  try {
    if (baseline) {
      const after = await fingerprint();
      report.originalRowsUnchanged = JSON.stringify(baseline) === JSON.stringify(after);
      report.rowFingerprints = { before: baseline, after };
      assert(report.originalRowsUnchanged, 'Preexisting rows changed during the smoke test.');
      check('preexisting_users_and_subscriptions_unchanged');
    }
  } catch { report.originalRowsUnchanged = false; success = false; }
  report.passed = success && report.originalRowsUnchanged && !report.checkoutCleanupFailed;
  report.finishedAt = new Date().toISOString();
  registry.completed = report.passed;
  await saveAccounts();
  await fs.writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  await db.end().catch(() => {});
  console.log(JSON.stringify({ check: 'local_integration', passed: report.passed,
    checks: report.checks.length, credentialsSavedLocally: true, originalRowsUnchanged: report.originalRowsUnchanged }));
  if (!report.passed) process.exitCode = 1;
}
