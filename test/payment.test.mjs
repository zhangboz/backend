import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import Stripe from 'stripe';
import { createPaymentRouter } from '../routes/paymentRouter.mjs';
import { createWebhookRouter, reconcileStripeEvent } from '../routes/webhookRouter.mjs';
import { hasSubscriptionAccess, subscriptionValues, assertStripeMode, getStripeClient, stripeDeploymentId } from '../services/stripeService.mjs';

const metadata = (deployment = 'local') => ({ app: 'homework-help-ai', deployment_id: deployment, user_id: '42' });

const subscription = overrides => ({ id: 'sub_test', customer: 'cus_test', livemode: false,
  status: 'trialing', created: 100, metadata: metadata(), cancel_at_period_end: false,
  items: { data: [{ price: { id: 'price_test' }, current_period_end: 2000000000 }] }, ...overrides });
const row = { stripe_subscription_id: 'sub_test', stripe_customer_id: 'cus_test', subscription_status: 'trialing' };

function fixture(existing) {
  const writes = [];
  const database = { query: async (sql, args) => {
    if (/FROM users\b/.test(sql)) return { rows: [{ user_id: 42, email: 'test@example.invalid' }] };
    if (sql.startsWith('SELECT')) return { rows: existing ? [existing] : [] };
    writes.push({ sql, args }); return { rows: [], rowCount: 1 };
  } };
  const calls = [];
  const stripe = {
    prices: { retrieve: async () => ({ id: 'price_test', active: true, type: 'recurring', livemode: false }) },
    customers: { retrieve: async () => ({ id: 'cus_test', email: 'test@example.invalid', livemode: false, metadata: {} }) },
    subscriptions: {
      retrieve: async () => subscription(),
      list: async () => ({ data: existing ? [await stripe.subscriptions.retrieve(existing.stripe_subscription_id)] : [], has_more: false }),
      update: async (id, changes) => { calls.push({ id, changes }); return subscription(changes); },
    },
    checkout: { sessions: { create: async (payload, options) => {
      calls.push({ payload, options }); return { livemode: false, url: 'https://checkout.stripe.com/test' };
    } } },
  };
  return { database, stripe, writes, calls };
}

async function serve(t, router, { raw = false } = {}) {
  const app = express();
  app.use(raw ? express.raw({ type: 'application/json' }) : express.json());
  app.use((req, res, next) => { req.user = { user_id: 42, email: 'test@example.invalid' }; next(); });
  app.use(router);
  app.use((error, req, res, next) => res.status(error.statusCode || 500).json({ message: error.message }));
  const server = await new Promise(resolve => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return (path, body = {}, headers = {}) => fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
}

test('trialing grants access, canceled and incomplete do not', () => {
  assert.equal(hasSubscriptionAccess('trialing'), true);
  assert.equal(hasSubscriptionAccess('active'), true);
  for (const state of ['canceled', 'incomplete', 'past_due', 'inactive']) assert.equal(hasSubscriptionAccess(state), false);
});

test('local deployment defaults locally and production requires an explicit identity', () => {
  assert.equal(stripeDeploymentId({}), 'local');
  assert.equal(stripeDeploymentId({ NODE_ENV: 'production', STRIPE_DEPLOYMENT_ID: 'synapse-render' }), 'synapse-render');
  assert.throws(() => stripeDeploymentId({ NODE_ENV: 'production' }), /deployment identity/);
  assert.throws(() => stripeDeploymentId({ STRIPE_DEPLOYMENT_ID: 'invalid scope' }), /deployment identity/);
});

test('local mode refuses live keys and live objects before writes', () => {
  const previous = process.env.STRIPE_SECRET_KEY;
  const mode = process.env.STRIPE_TEST_MODE;
  process.env.STRIPE_SECRET_KEY = 'sk_live_fixture'; process.env.STRIPE_TEST_MODE = 'true';
  try { assert.throws(getStripeClient, /test key/); }
  finally {
    if (previous === undefined) delete process.env.STRIPE_SECRET_KEY; else process.env.STRIPE_SECRET_KEY = previous;
    if (mode === undefined) delete process.env.STRIPE_TEST_MODE; else process.env.STRIPE_TEST_MODE = mode;
  }
  assert.throws(() => assertStripeMode({ livemode: true }, true), /test environment/);
});

test('uses the Stripe Basil item period end and rejects missing periods', () => {
  assert.equal(subscriptionValues(subscription())[4].getTime(), 2000000000000);
  assert.throws(() => subscriptionValues(subscription({ items: { data: [] } })), /incomplete subscription/);
});

test('checkout includes seven-day trial and stable user ownership', async t => {
  const f = fixture();
  const post = await serve(t, createPaymentRouter({ database: f.database, getStripe: () => f.stripe, testOnly: () => true, priceId: () => 'price_test' }));
  const res = await post('/create-checkout-session', { returnPath: '/account?from=results' });
  assert.equal(res.status, 200);
  const { payload, options } = f.calls[0];
  assert.equal(payload.client_reference_id, '42');
  assert.equal(payload.subscription_data.trial_period_days, 7);
  assert.equal(payload.subscription_data.metadata.user_id, '42');
  assert.deepEqual(payload.metadata, metadata());
  assert.deepEqual(payload.subscription_data.metadata, metadata());
  assert.match(payload.success_url, /from=results&payment=success/);
  assert.match(options.idempotencyKey, /^local-checkout-42-/);
});

test('duplicate trial checkout and off-site return paths are rejected', async t => {
  const f = fixture(row);
  const post = await serve(t, createPaymentRouter({ database: f.database, getStripe: () => f.stripe, testOnly: () => true }));
  assert.equal((await post('/create-checkout-session')).status, 409);
  assert.equal(f.calls.length, 0);
  const empty = fixture();
  const invalid = await serve(t, createPaymentRouter({ database: empty.database, getStripe: () => empty.stripe, testOnly: () => true }));
  assert.equal((await invalid('/create-checkout-session', { returnPath: '//example.invalid' })).status, 400);
  assert.equal(empty.calls.length, 0);
});

test('Checkout idempotency distinguishes new lifecycle and changed return URLs', async t => {
  const prior = { ...row, subscription_status: 'canceled' };
  const f = fixture(prior);
  f.stripe.subscriptions.retrieve = async id => subscription({ id, status: 'canceled' });
  const post = await serve(t, createPaymentRouter({ database: f.database, getStripe: () => f.stripe,
    testOnly: () => true, priceId: () => 'price_test', now: () => 1200000 }));
  assert.equal((await post('/create-checkout-session', { returnPath: '/account' })).status, 200);
  assert.equal((await post('/create-checkout-session', { returnPath: '/account' })).status, 200);
  assert.equal(f.calls[0].options.idempotencyKey, f.calls[1].options.idempotencyKey);
  prior.stripe_subscription_id = 'sub_later';
  assert.equal((await post('/create-checkout-session', { returnPath: '/account' })).status, 200);
  assert.deepEqual(f.calls[0].payload, f.calls[2].payload);
  assert.notEqual(f.calls[0].options.idempotencyKey, f.calls[2].options.idempotencyKey);
  assert.equal((await post('/create-checkout-session', { returnPath: '/results' })).status, 200);
  assert.notEqual(f.calls[2].options.idempotencyKey, f.calls[3].options.idempotencyKey);
});

test('a missing historical subscription with an unverifiable customer cannot be checked out or mutated', async t => {
  const f = fixture(row);
  f.stripe.subscriptions.retrieve = async () => { throw Object.assign(new Error('missing'), { code: 'resource_missing' }); };
  f.stripe.customers.retrieve = async () => { throw Object.assign(new Error('missing'), { code: 'resource_missing' }); };
  const post = await serve(t, createPaymentRouter({ database: f.database, getStripe: () => f.stripe, testOnly: () => true }));
  for (const path of ['/create-checkout-session', '/cancel-subscription', '/reactivate-subscription']) {
    assert.equal((await post(path)).status, 409);
  }
  assert.equal(f.calls.length, 0); assert.equal(f.writes.length, 0);
});

test('missing old subscription and verified empty customer allow checkout despite cached active state', async t => {
  const f = fixture({ ...row, stripe_subscription_id: 'sub_historical', subscription_status: 'active' });
  f.stripe.subscriptions.retrieve = async () => { throw Object.assign(new Error('missing'), { code: 'resource_missing' }); };
  f.stripe.subscriptions.list = async () => ({ data: [], has_more: false });
  const post = await serve(t, createPaymentRouter({ database: f.database, getStripe: () => f.stripe,
    testOnly: () => true, priceId: () => 'price_test' }));
  assert.equal((await post('/create-checkout-session')).status, 200);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].payload.customer, 'cus_test');
  assert.equal(f.calls[0].payload.customer_email, undefined);
  for (const path of ['/cancel-subscription', '/reactivate-subscription']) assert.equal((await post(path)).status, 409);
  assert.equal(f.calls.length, 1, 'A missing Stripe object must never be mutated.');
});

test('an unverified resolver state blocks all payment actions without creating a checkout', async t => {
  for (const syncState of ['unavailable', 'unlinked', 'foreign']) {
    const f = fixture(row);
    const resolver = { resolve: async () => ({ state: { subscriptionStatus: 'unknown',
      subscriptionSyncState: syncState, subscriptionVerified: false, canSubscribe: false, canManageSubscription: false },
      row, subscription: null, customer: null, replacementAllowed: false }) };
    const post = await serve(t, createPaymentRouter({ database: f.database, getStripe: () => f.stripe,
      resolver, testOnly: () => true }));
    for (const path of ['/create-checkout-session', '/cancel-subscription', '/reactivate-subscription']) {
      assert.equal((await post(path)).status, syncState === 'unavailable' ? 503 : 409);
    }
    assert.equal(f.calls.length, 0);
    assert.equal(f.writes.length, 0);
  }
});

test('verified incomplete subscription resumes its invoice without creating a second checkout', async t => {
  const f = fixture(row);
  const incomplete = subscription({ status: 'incomplete' });
  const resolver = { resolve: async () => ({ state: { subscriptionStatus: 'incomplete',
    subscriptionSyncState: 'verified', subscriptionVerified: true, canSubscribe: true, canManageSubscription: false },
    row, subscription: incomplete, customer: { id: 'cus_test' }, replacementAllowed: false }) };
  f.stripe.subscriptions.retrieve = async (id, options) => {
    assert.equal(id, incomplete.id); assert.deepEqual(options.expand, ['latest_invoice']);
    return { ...incomplete, latest_invoice: { status: 'open', hosted_invoice_url: 'https://invoice.stripe.com/test' } };
  };
  const post = await serve(t, createPaymentRouter({ database: f.database, getStripe: () => f.stripe, resolver, testOnly: () => true }));
  const response = await post('/create-checkout-session');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { url: 'https://invoice.stripe.com/test' });
  assert.equal(f.calls.length, 0);
});

test('an untagged incomplete subscription cannot be resumed through the checkout endpoint', async t => {
  const f = fixture({ ...row, subscription_status: 'incomplete' });
  f.stripe.subscriptions.retrieve = async (_id, options) => {
    assert.equal(options?.expand, undefined, 'An unowned invoice must not be fetched for payment.');
    return subscription({ status: 'incomplete', metadata: { user_id: '42' } });
  };
  const post = await serve(t, createPaymentRouter({ database: f.database, getStripe: () => f.stripe, testOnly: () => true }));
  assert.equal((await post('/create-checkout-session')).status, 409);
  assert.equal(f.calls.length, 0);
});

test('trial can be canceled and a pending trial cancellation can be restored', async t => {
  const f = fixture(row);
  const post = await serve(t, createPaymentRouter({ database: f.database, getStripe: () => f.stripe, testOnly: () => true }));
  assert.equal((await post('/cancel-subscription')).status, 200);
  assert.equal(f.calls[0].changes.cancel_at_period_end, true);
  assert.equal(f.writes.at(-1).args[0], 'trialing');
  assert.equal((await post('/reactivate-subscription')).status, 409);
  f.stripe.subscriptions.retrieve = async () => subscription({ cancel_at_period_end: true });
  assert.equal((await post('/reactivate-subscription')).status, 200);
  assert.equal(f.calls[1].changes.cancel_at_period_end, false);
});

test('duplicate checkout webhooks reconcile by upsert with current Stripe state', async () => {
  const f = fixture();
  const event = { type: 'checkout.session.completed', livemode: false,
    data: { object: { subscription: 'sub_test', customer: 'cus_test', client_reference_id: '42', metadata: metadata() } } };
  await reconcileStripeEvent(event, { ...f }); await reconcileStripeEvent(event, { ...f });
  assert.equal(f.writes.length, 2);
  assert.ok(f.writes.every(write => write.sql.includes('ON CONFLICT (user_id)')));
  assert.equal(f.writes[0].args[4], 'trialing');
});

test('delayed update uses current status and matches subscription ID, not customer alone', async () => {
  const f = fixture(row);
  f.stripe.subscriptions.retrieve = async () => subscription({ status: 'canceled' });
  await reconcileStripeEvent({ type: 'customer.subscription.updated', livemode: false,
    data: { object: { id: 'sub_test', status: 'active', metadata: metadata() } } }, { ...f });
  assert.equal(f.writes[0].args[0], 'canceled');
  assert.match(f.writes[0].sql, /WHERE stripe_subscription_id = \$4 AND stripe_customer_id = \$5/);
});

test('owned subscription creation can arrive before Checkout completion', async () => {
  const f = fixture();
  f.stripe.subscriptions.retrieve = async () => subscription();
  await reconcileStripeEvent({ type: 'customer.subscription.created', livemode: false,
    data: { object: { id: 'sub_test', metadata: metadata() } } }, { ...f });
  assert.match(f.writes[0].sql, /INSERT INTO subscriptions/);
  assert.equal(f.writes[0].args[0], '42');
});

test('older checkout cannot overwrite newer subscription', async () => {
  const f = fixture({ ...row, stripe_subscription_id: 'sub_new' });
  f.stripe.subscriptions.retrieve = async id => subscription({ id, created: id === 'sub_new' ? 200 : 100 });
  await reconcileStripeEvent({ type: 'checkout.session.completed', livemode: false,
    data: { object: { subscription: 'sub_test', customer: 'cus_test', client_reference_id: '42', metadata: metadata() } } }, { ...f });
  assert.equal(f.writes.length, 0);
});

test('new scoped subscription replaces a missing old ID for the verified same customer despite cached active status', async () => {
  const previous = { ...row, stripe_subscription_id: 'sub_missing', subscription_status: 'active' };
  const f = fixture(previous);
  f.stripe.subscriptions.retrieve = async id => {
    if (id === 'sub_missing') throw Object.assign(new Error('missing'), { code: 'resource_missing' });
    return subscription({ id, metadata: metadata('synapse-render') });
  };
  await reconcileStripeEvent({ type: 'customer.subscription.created', livemode: false,
    data: { object: subscription({ metadata: metadata('synapse-render') }) } }, { ...f, deploymentId: 'synapse-render' });
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].args[0], '42');
  assert.equal(f.writes[0].args[7], 'sub_missing');
  assert.match(f.writes[0].sql, /subscriptions.stripe_subscription_id = \$8/);
  assert.doesNotMatch(f.writes[0].sql, /subscription_status NOT IN/);
});

test('current canceled Stripe state allows a newer scoped replacement even when database says active', async () => {
  const f = fixture({ ...row, stripe_subscription_id: 'sub_previous', subscription_status: 'active' });
  f.stripe.subscriptions.retrieve = async id => subscription({ id,
    status: id === 'sub_previous' ? 'canceled' : 'trialing', created: id === 'sub_previous' ? 90 : 100 });
  await reconcileStripeEvent({ type: 'customer.subscription.created', livemode: false,
    data: { object: subscription() } }, { ...f });
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].args[7], 'sub_previous');
});

test('missing-old replacement fails closed for customer conflicts and Stripe outages', async () => {
  const cases = [
    { customer: { id: 'cus_different', email: 'test@example.invalid', livemode: false } },
    { customer: { id: 'cus_test', email: 'someone@example.invalid', livemode: false } },
    { customer: { id: 'cus_test', email: 'test@example.invalid', livemode: true } },
    { customer: { id: 'cus_test', email: 'test@example.invalid', livemode: false, deleted: true } },
    ...[{ deployment_id: 'foreign' }, { user_id: '99' }, { app: 'another-app' }].map(tags => ({
      customer: { id: 'cus_test', email: 'test@example.invalid', livemode: false, metadata: tags },
    })),
    { oldError: 'api_connection_error' }, { customerError: 'api_connection_error' }, { customerError: 'resource_missing' },
  ];
  for (const scenario of cases) {
    const f = fixture({ ...row, stripe_subscription_id: 'sub_missing', subscription_status: 'active' });
    f.stripe.subscriptions.retrieve = async id => {
      if (id === 'sub_missing') throw Object.assign(new Error('Stripe error'), { code: scenario.oldError || 'resource_missing' });
      return subscription();
    };
    f.stripe.customers.retrieve = async () => {
      if (scenario.customerError) throw Object.assign(new Error('Stripe error'), { code: scenario.customerError });
      return scenario.customer;
    };
    await assert.rejects(reconcileStripeEvent({ type: 'customer.subscription.created', livemode: false,
      data: { object: subscription() } }, { ...f }));
    assert.equal(f.writes.length, 0);
  }
});

test('overlapping webhook deliveries serialize their current-state fetch and write', async () => {
  const f = fixture(row);
  let release;
  let started;
  const blocked = new Promise(resolve => { release = resolve; });
  const writeStarted = new Promise(resolve => { started = resolve; });
  let reads = 0;
  f.stripe.subscriptions.retrieve = async () => { reads++; return subscription(); };
  f.database.query = async () => { started(); await blocked; return { rows: [] }; };
  const event = { type: 'customer.subscription.updated', livemode: false, data: { object: { id: 'sub_test', metadata: metadata() } } };
  const first = reconcileStripeEvent(event, { ...f });
  await writeStarted;
  const second = reconcileStripeEvent(event, { ...f });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 1);
  release();
  await Promise.all([first, second]);
  assert.equal(reads, 2);
});

test('local and cloud ignore foreign or untagged events before any database access', async () => {
  for (const deploymentId of ['local', 'synapse-render']) {
    for (const eventMetadata of [metadata(deploymentId === 'local' ? 'synapse-render' : 'local'),
      { app: 'homework-help-ai', user_id: '42' }]) {
      for (const type of ['checkout.session.completed', 'customer.subscription.created',
        'customer.subscription.updated', 'customer.subscription.deleted']) {
        await reconcileStripeEvent({ type, livemode: false, data: { object: {
          id: 'sub_test', subscription: 'sub_test', customer: 'cus_test', client_reference_id: '42', metadata: eventMetadata,
        } } }, {
          deploymentId,
          database: { query: async () => assert.fail('Foreign events must not access the copied user ID.') },
          stripe: { subscriptions: { retrieve: async () => assert.fail('Foreign events need no Stripe retrieval.') } },
        });
      }
    }
  }
});

test('same-scope event cannot claim a current subscription from another deployment', async () => {
  const f = fixture();
  f.stripe.subscriptions.retrieve = async () => subscription({ metadata: metadata('local') });
  f.database.query = async () => assert.fail('Mismatched current ownership must not access the database.');
  await reconcileStripeEvent({ type: 'checkout.session.completed', livemode: false, data: { object: {
    subscription: 'sub_test', customer: 'cus_test', client_reference_id: '42', metadata: metadata('synapse-render'),
  } } }, { ...f, deploymentId: 'synapse-render' });
});

test('a new scoped creation cannot replace an untagged historical subscription on the copied user', async () => {
  const f = fixture({ ...row, stripe_subscription_id: 'sub_legacy', subscription_status: 'canceled' });
  f.stripe.subscriptions.retrieve = async id => subscription({ id, status: 'canceled',
    metadata: id === 'sub_legacy' ? { user_id: '42' } : metadata('synapse-render') });
  await assert.rejects(reconcileStripeEvent({ type: 'customer.subscription.created', livemode: false,
    data: { object: subscription({ metadata: metadata('synapse-render') }) } },
  { ...f, deploymentId: 'synapse-render' }), /predates deployment isolation/);
  assert.equal(f.writes.length, 0);
});

test('same user and customer IDs cannot mutate a foreign or untagged saved subscription', async t => {
  for (const subscriptionMetadata of [metadata('local'), { app: 'homework-help-ai', user_id: '42' },
    { ...metadata('synapse-render'), user_id: '99' }]) {
    const f = fixture(row);
    f.stripe.subscriptions.retrieve = async () => subscription({ metadata: subscriptionMetadata });
    const post = await serve(t, createPaymentRouter({ database: f.database, getStripe: () => f.stripe,
      testOnly: () => true, deploymentId: () => 'synapse-render' }));
    for (const path of ['/create-checkout-session', '/cancel-subscription', '/reactivate-subscription']) {
      assert.equal((await post(path)).status, 409);
    }
    assert.equal(f.calls.length, 0);
    // Read-only verification may refresh an untagged legacy projection, but it
    // must preserve the saved identity and never mutate or adopt Stripe objects.
    assert.ok(f.writes.every(write => write.args[0] === row.stripe_subscription_id &&
      write.args[6] === row.stripe_customer_id && write.args[7] === row.stripe_subscription_id));
  }
});

test('cloud checkout, creation webhook, cancellation and restoration keep their deployment ownership', async t => {
  const deploymentId = 'synapse-render';
  const f = fixture();
  const options = { database: f.database, getStripe: () => f.stripe, testOnly: () => true,
    priceId: () => 'price_test', deploymentId: () => deploymentId, now: () => 1200000 };
  const post = await serve(t, createPaymentRouter(options));
  assert.equal((await post('/create-checkout-session')).status, 200);
  const payload = f.calls[0].payload;
  assert.deepEqual(payload.metadata, metadata(deploymentId));
  assert.deepEqual(payload.subscription_data.metadata, metadata(deploymentId));
  f.stripe.subscriptions.retrieve = async () => subscription({ metadata: payload.subscription_data.metadata });
  await reconcileStripeEvent({ type: 'customer.subscription.created', livemode: false,
    data: { object: subscription({ metadata: payload.subscription_data.metadata }) } }, { ...f, deploymentId });
  assert.equal(f.writes[0].args[0], '42');
  assert.equal(f.writes[0].args[4], 'trialing');
  const existing = fixture(row);
  let current = subscription({ metadata: metadata(deploymentId) });
  existing.stripe.subscriptions.retrieve = async () => current;
  existing.stripe.subscriptions.update = async (_id, changes) => {
    current = { ...current, ...changes }; return current;
  };
  const change = await serve(t, createPaymentRouter({ ...options, database: existing.database, getStripe: () => existing.stripe }));
  assert.equal((await change('/cancel-subscription')).status, 200);
  assert.equal(current.cancel_at_period_end, true);
  assert.equal((await change('/reactivate-subscription')).status, 200);
  assert.equal(current.cancel_at_period_end, false);
  assert.equal(existing.writes.filter(write => write.sql.includes('SET subscription_status =')).length, 2);
});

test('webhook rejects invalid signatures and accepts a correctly signed ignored test event', async t => {
  const localStripe = new Stripe('sk_test_fixture');
  const secret = 'whsec_local_fixture';
  const f = fixture();
  const router = createWebhookRouter({ database: f.database, getStripe: () => localStripe,
    testOnly: () => true, webhookSecret: () => secret });
  const post = await serve(t, router, { raw: true });
  const body = { id: 'evt_fixture', type: 'unhandled.fixture', livemode: false, data: { object: {} } };
  assert.equal((await post('/', body, { 'stripe-signature': 'invalid' })).status, 400);
  const signature = localStripe.webhooks.generateTestHeaderString({ payload: JSON.stringify(body), secret });
  assert.equal((await post('/', body, { 'stripe-signature': signature })).status, 200);
  const foreign = { ...body, type: 'customer.subscription.created', data: { object: subscription({ metadata: metadata('synapse-render') }) } };
  const foreignSignature = localStripe.webhooks.generateTestHeaderString({ payload: JSON.stringify(foreign), secret });
  assert.equal((await post('/', foreign, { 'stripe-signature': foreignSignature })).status, 200);
  const live = { ...body, livemode: true };
  const liveSignature = localStripe.webhooks.generateTestHeaderString({ payload: JSON.stringify(live), secret });
  assert.equal((await post('/', live, { 'stripe-signature': liveSignature })).status, 409);
  assert.equal(f.writes.length, 0);
});
