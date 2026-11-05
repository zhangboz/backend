import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createSubscriptionResolver } from '../services/subscriptionState.mjs';
import { createRequireSubscription } from '../middleware/auth.mjs';
import { createUserStatusRouter } from '../routes/userStatusRouter.mjs';

const user = { user_id: 42, email: 'test@example.invalid', language: 'en' };
const metadata = { app: 'homework-help-ai', deployment_id: 'synapse-render', user_id: '42' };
const row = { user_id: 42, stripe_customer_id: 'cus_current', stripe_subscription_id: 'sub_current', stripe_price_id: 'price_current',
  subscription_status: 'active', current_period_end: new Date('2025-07-26'), cancel_at_period_end: false,
  projection_version: '2025-06-26 06:49:00.123456+00' };
const subscription = changes => ({ id: 'sub_current', customer: 'cus_current', livemode: false, status: 'active',
  metadata, created: 100, cancel_at_period_end: false,
  items: { data: [{ price: { id: 'price_current' }, current_period_end: 1900000000 }] }, ...changes });
const missing = () => { throw Object.assign(new Error('not found'), { code: 'resource_missing' }); };
function fixture(saved = row) {
  const writes = [], logs = [];
  const database = { query: async (sql, args) => {
    if (sql.startsWith('SELECT')) return { rows: saved ? [{ ...saved }] : [] };
    writes.push({ sql, args }); return { rowCount: 1, rows: [] };
  } };
  const stripe = {
    subscriptions: { retrieve: async () => subscription(), list: async () => ({ data: [], has_more: false }) },
    customers: { retrieve: async () => ({ id: 'cus_current', email: user.email, livemode: false, metadata: {} }) },
  };
  const resolver = createSubscriptionResolver({ database, getStripe: () => stripe, testOnly: () => true,
    deploymentId: () => 'synapse-render', logger: { warn: value => logs.push(value) }, now: () => 1800000000000 });
  return { resolver, stripe, database, writes, logs };
}

test('Stripe canceled replaces a stale active cache and billing date', async () => {
  const f = fixture(); f.stripe.subscriptions.retrieve = async () => subscription({ status: 'canceled' });
  const result = await f.resolver.resolve(user);
  assert.equal(result.state.subscriptionStatus, 'canceled');
  assert.equal(result.state.subscriptionVerified, true);
  assert.equal(result.state.canManageSubscription, false);
  assert.equal(result.state.canSubscribe, true);
  assert.equal(f.writes[0].args[2], 'canceled');
});

test('fresh Stripe active wins over expired database period, and reads are not cached', async () => {
  const f = fixture({ ...row, subscription_status: 'canceled' }); let calls = 0;
  f.stripe.subscriptions.retrieve = async () => { calls++; return subscription({ status: calls === 1 ? 'active' : 'canceled' }); };
  assert.equal((await f.resolver.resolve(user)).state.subscriptionStatus, 'active');
  assert.equal((await f.resolver.resolve(user)).state.subscriptionStatus, 'canceled');
  assert.equal(calls, 2);
});

test('confirmed missing subscription with an owned empty customer clears stale status but retains IDs', async () => {
  const f = fixture(); f.stripe.subscriptions.retrieve = missing;
  const result = await f.resolver.resolve(user);
  assert.equal(result.state.subscriptionSyncState, 'none');
  assert.equal(result.state.subscriptionStatus, 'inactive');
  assert.equal(result.state.subscriptionVerified, true);
  assert.equal(result.state.currentPeriodEnd, null);
  assert.equal(result.state.canSubscribe, true);
  assert.equal(result.replacementAllowed, true);
  assert.deepEqual(f.writes[0].args.slice(0, 5), ['sub_current', 'price_current', 'inactive', null, false]);
});

test('missing subscription alone, missing customer, or list failure never proves no subscription', async () => {
  for (const failure of ['customer', 'list']) {
    const f = fixture(); f.stripe.subscriptions.retrieve = missing;
    if (failure === 'customer') f.stripe.customers.retrieve = missing;
    else f.stripe.subscriptions.list = async () => { throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }); };
    const { state } = await f.resolver.resolve(user);
    assert.equal(state.subscriptionStatus, 'unknown'); assert.equal(state.canSubscribe, false);
    assert.equal(state.subscriptionVerified, false); assert.equal(f.writes.length, 0);
  }
});

test('rate limits, auth errors and network errors neither grant stale access nor erase the projection', async () => {
  for (const code of ['rate_limit', 'invalid_api_key', 'ETIMEDOUT']) {
    const f = fixture(); f.stripe.subscriptions.retrieve = async () => { throw Object.assign(new Error('sensitive provider detail'), { code }); };
    const { state } = await f.resolver.resolve(user);
    assert.equal(state.subscriptionSyncState, 'unavailable');
    assert.equal(state.subscriptionStatus, 'unknown'); assert.equal(state.currentPeriodEnd, null);
    assert.equal(state.canSubscribe, false); assert.equal(f.writes.length, 0);
    assert(!JSON.stringify(state).includes('sensitive')); assert(!f.logs.join('').includes('sensitive'));
  }
});

test('foreign scope, wrong user/customer, and live objects are not accepted from copied DB links', async () => {
  for (const changes of [{ metadata: { ...metadata, deployment_id: 'local' } },
    { metadata: { ...metadata, user_id: '99' } }, { customer: 'cus_other' }, { id: 'sub_other' }, { livemode: true }]) {
    const f = fixture(); f.stripe.subscriptions.retrieve = async () => subscription(changes);
    const { state } = await f.resolver.resolve(user);
    assert.equal(state.subscriptionVerified, false); assert.equal(state.canSubscribe, false); assert.equal(f.writes.length, 0);
  }
  const f = fixture(); f.stripe.customers.retrieve = async () => ({ id: 'cus_wrong', email: user.email, livemode: false });
  assert.equal((await f.resolver.resolve(user)).state.subscriptionSyncState, 'foreign');
});

test('untagged historical subscription may be read only after customer ownership verification', async () => {
  const f = fixture(); f.stripe.subscriptions.retrieve = async () => subscription({ metadata: {}, status: 'canceled' });
  const { state } = await f.resolver.resolve(user);
  assert.equal(state.subscriptionStatus, 'canceled'); assert.equal(state.subscriptionVerified, true);
  assert.equal(state.canManageSubscription, false); assert.equal(state.canSubscribe, false);
  f.stripe.customers.retrieve = async () => ({ id: 'cus_current', email: 'someone@example.invalid', livemode: false });
  assert.equal((await f.resolver.resolve(user)).state.subscriptionSyncState, 'foreign');
});

test('missed webhook is repaired from the linked customer scoped subscription, including pagination', async () => {
  const f = fixture(); f.stripe.subscriptions.retrieve = missing; const cursors = [];
  f.stripe.subscriptions.list = async args => {
    cursors.push(args.starting_after);
    return args.starting_after
      ? { data: [subscription({ id: 'sub_new', created: 200 })], has_more: false }
      : { data: [subscription({ id: 'sub_old', metadata: {}, status: 'canceled' })], has_more: true };
  };
  const result = await f.resolver.resolve(user);
  assert.equal(result.subscription.id, 'sub_new'); assert.equal(result.state.subscriptionStatus, 'active');
  assert.deepEqual(cursors, [undefined, 'sub_old']);
  assert.equal(f.writes[0].args[0], 'sub_new'); assert.equal(f.writes[0].args[7], 'sub_current');
});

test('foreign existing subscriptions prevent a new subscription when the old ID is gone', async () => {
  const f = fixture(); f.stripe.subscriptions.retrieve = missing;
  f.stripe.subscriptions.list = async () => ({ data: [subscription({ metadata: {} })], has_more: false });
  const { state } = await f.resolver.resolve(user);
  assert.equal(state.subscriptionSyncState, 'unlinked'); assert.equal(state.canSubscribe, false); assert.equal(f.writes.length, 0);
});

test('an owned active subscription takes precedence over a newer incomplete checkout', async () => {
  const f = fixture(); f.stripe.subscriptions.retrieve = missing;
  f.stripe.subscriptions.list = async () => ({ data: [subscription({ id: 'sub_paid', created: 100 }),
    subscription({ id: 'sub_pending', status: 'incomplete', created: 200 })], has_more: false });
  const result = await f.resolver.resolve(user);
  assert.equal(result.subscription.id, 'sub_paid');
  assert.equal(result.state.subscriptionStatus, 'active'); assert.equal(result.state.canSubscribe, false);
});

test('projection uses exact database version to avoid overwriting a newer webhook snapshot', async () => {
  const f = fixture(); await f.resolver.resolve(user);
  assert.match(f.writes[0].sql, /updated_at = \$9::timestamptz/);
  assert.equal(f.writes[0].args[8], row.projection_version);
});

test('projection write failure does not turn verified Stripe state into cached state', async () => {
  const f = fixture(); const query = f.database.query;
  f.database.query = async (sql, args) => { if (sql.startsWith('UPDATE')) throw new Error('DB write unavailable'); return query(sql, args); };
  assert.equal((await f.resolver.resolve(user)).state.subscriptionStatus, 'active');
  assert(f.logs.some(line => line.includes('subscription_projection_failed')));
});

test('concurrent reads coalesce only while in flight', async () => {
  const f = fixture(); let release; const block = new Promise(resolve => { release = resolve; }); let calls = 0;
  f.stripe.subscriptions.retrieve = async () => { calls++; await block; return subscription(); };
  const a = f.resolver.resolve(user), b = f.resolver.resolve(user);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 1);
  release(); await Promise.all([a, b]); await f.resolver.resolve(user); assert.equal(calls, 2);
});

test('new account without a billing link is inactive but does not claim a Stripe verification', async () => {
  const f = fixture(null); f.stripe.subscriptions.retrieve = () => assert.fail('No subscription to retrieve');
  const { state } = await f.resolver.resolve(user);
  assert.equal(state.subscriptionSyncState, 'none'); assert.equal(state.subscriptionVerified, false); assert.equal(state.canSubscribe, true);
});

test('account status and premium middleware share live Stripe truth, keeping login during outages', async t => {
  const f = fixture(); const app = express(); app.use((req, res, next) => { req.user = user; next(); });
  app.use(createUserStatusRouter({ database: f.database, resolver: f.resolver }));
  app.get('/premium', createRequireSubscription({ resolver: f.resolver }), (req, res) => res.json({ allowed: true }));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const get = p => fetch(`http://127.0.0.1:${server.address().port}${p}`);
  assert.equal((await get('/premium')).status, 200);
  f.stripe.subscriptions.retrieve = async () => subscription({ status: 'canceled' });
  assert.equal((await get('/premium')).status, 403);
  const account = await get('/status'); assert.equal(account.status, 200);
  assert.equal(account.headers.get('cache-control'), 'private, no-store');
  assert.equal((await account.json()).user.subscriptionStatus, 'canceled');
  f.stripe.subscriptions.retrieve = async () => { throw new Error('upstream failure'); };
  const unavailable = await get('/status'); assert.equal(unavailable.status, 200);
  assert.equal((await unavailable.json()).user.subscriptionStatus, 'unknown');
  assert.equal((await get('/premium')).status, 503);
});
