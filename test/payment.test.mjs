import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import Stripe from 'stripe';
import { createPaymentRouter } from '../routes/paymentRouter.mjs';
import { createWebhookRouter, reconcileStripeEvent } from '../routes/webhookRouter.mjs';
import { hasSubscriptionAccess, subscriptionValues, assertStripeMode, getStripeClient } from '../services/stripeService.mjs';

const subscription = overrides => ({ id: 'sub_test', customer: 'cus_test', livemode: false,
  status: 'trialing', created: 100, metadata: { user_id: '42' }, cancel_at_period_end: false,
  items: { data: [{ price: { id: 'price_test' }, current_period_end: 2000000000 }] }, ...overrides });
const row = { stripe_subscription_id: 'sub_test', stripe_customer_id: 'cus_test', subscription_status: 'trialing' };

function fixture(existing) {
  const writes = [];
  const database = { query: async (sql, args) => {
    if (sql.startsWith('SELECT')) return { rows: existing ? [existing] : [] };
    writes.push({ sql, args }); return { rows: [], rowCount: 1 };
  } };
  const calls = [];
  const stripe = {
    prices: { retrieve: async () => ({ id: 'price_test', active: true, type: 'recurring', livemode: false }) },
    customers: { retrieve: async () => ({ id: 'cus_test', livemode: false }) },
    subscriptions: {
      retrieve: async () => subscription(),
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

test('historical subscriptions missing in test mode cannot be mutated', async t => {
  const f = fixture(row);
  f.stripe.subscriptions.retrieve = async () => { throw Object.assign(new Error('missing'), { code: 'resource_missing' }); };
  const post = await serve(t, createPaymentRouter({ database: f.database, getStripe: () => f.stripe, testOnly: () => true }));
  for (const path of ['/create-checkout-session', '/cancel-subscription', '/reactivate-subscription']) {
    assert.equal((await post(path)).status, 409);
  }
  assert.equal(f.calls.length, 0); assert.equal(f.writes.length, 0);
});

test('trial can be canceled and a pending trial cancellation can be restored', async t => {
  const f = fixture(row);
  const post = await serve(t, createPaymentRouter({ database: f.database, getStripe: () => f.stripe, testOnly: () => true }));
  assert.equal((await post('/cancel-subscription')).status, 200);
  assert.equal(f.calls[0].changes.cancel_at_period_end, true);
  assert.equal(f.writes[0].args[0], 'trialing');
  assert.equal((await post('/reactivate-subscription')).status, 409);
  f.stripe.subscriptions.retrieve = async () => subscription({ cancel_at_period_end: true });
  assert.equal((await post('/reactivate-subscription')).status, 200);
  assert.equal(f.calls[1].changes.cancel_at_period_end, false);
});

test('duplicate checkout webhooks reconcile by upsert with current Stripe state', async () => {
  const f = fixture();
  const event = { type: 'checkout.session.completed', livemode: false,
    data: { object: { subscription: 'sub_test', customer: 'cus_test', client_reference_id: '42' } } };
  await reconcileStripeEvent(event, { ...f }); await reconcileStripeEvent(event, { ...f });
  assert.equal(f.writes.length, 2);
  assert.ok(f.writes.every(write => write.sql.includes('ON CONFLICT (user_id)')));
  assert.equal(f.writes[0].args[4], 'trialing');
});

test('delayed update uses current status and matches subscription ID, not customer alone', async () => {
  const f = fixture(row);
  f.stripe.subscriptions.retrieve = async () => subscription({ status: 'canceled' });
  await reconcileStripeEvent({ type: 'customer.subscription.updated', livemode: false,
    data: { object: { id: 'sub_test', status: 'active' } } }, { ...f });
  assert.equal(f.writes[0].args[0], 'canceled');
  assert.match(f.writes[0].sql, /WHERE stripe_subscription_id = \$4 AND stripe_customer_id = \$5/);
});

test('owned subscription creation can arrive before Checkout completion', async () => {
  const f = fixture();
  f.stripe.subscriptions.retrieve = async () => subscription({ metadata: { app: 'homework-help-ai', user_id: '42' } });
  await reconcileStripeEvent({ type: 'customer.subscription.created', livemode: false,
    data: { object: { id: 'sub_test' } } }, { ...f });
  assert.match(f.writes[0].sql, /INSERT INTO subscriptions/);
  assert.equal(f.writes[0].args[0], '42');
});

test('older checkout cannot overwrite newer subscription', async () => {
  const f = fixture({ ...row, stripe_subscription_id: 'sub_new' });
  f.stripe.subscriptions.retrieve = async id => subscription({ id, created: id === 'sub_new' ? 200 : 100 });
  await reconcileStripeEvent({ type: 'checkout.session.completed', livemode: false,
    data: { object: { subscription: 'sub_test', customer: 'cus_test', client_reference_id: '42' } } }, { ...f });
  assert.equal(f.writes.length, 0);
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
  const event = { type: 'customer.subscription.updated', livemode: false, data: { object: { id: 'sub_test' } } };
  const first = reconcileStripeEvent(event, { ...f });
  await writeStarted;
  const second = reconcileStripeEvent(event, { ...f });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 1);
  release();
  await Promise.all([first, second]);
  assert.equal(reads, 2);
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
  const live = { ...body, livemode: true };
  const liveSignature = localStripe.webhooks.generateTestHeaderString({ payload: JSON.stringify(live), secret });
  assert.equal((await post('/', live, { 'stripe-signature': liveSignature })).status, 409);
  assert.equal(f.writes.length, 0);
});
