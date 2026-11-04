import Stripe from 'stripe';

export const hasSubscriptionAccess = status => ['active', 'trialing'].includes(status);
export const stripeTestOnly = () => process.env.STRIPE_TEST_MODE !== 'false';
export function paymentError(message, statusCode = 409) {
  return Object.assign(new Error(message), { statusCode });
}

let cachedClient;
let cachedKey;
export function getStripeClient() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw paymentError('Stripe is not configured.', 503);
  if (stripeTestOnly() && !/^(sk|rk)_test_/.test(key)) {
    throw paymentError('Local payments require a Stripe test key.', 503);
  }
  if (cachedKey !== key) {
    cachedClient = new Stripe(key, { timeout: 15000, maxNetworkRetries: 1 });
    cachedKey = key;
  }
  return cachedClient;
}

export function assertStripeMode(object, testOnly = stripeTestOnly()) {
  if (testOnly && object?.livemode !== false) {
    throw paymentError('This object does not belong to the Stripe test environment. Use a new local test account.');
  }
  return object;
}

export const stripeId = value => typeof value === 'string' ? value : value?.id;

export async function retrieveOwnedSubscription(stripe, row, userId, testOnly = stripeTestOnly()) {
  let subscription;
  try { subscription = await stripe.subscriptions.retrieve(row.stripe_subscription_id); }
  catch (error) {
    if (error.code === 'resource_missing') {
      throw paymentError('This account has a historical subscription from another Stripe environment. Use a new local test account.');
    }
    throw error;
  }
  assertStripeMode(subscription, testOnly);
  if (stripeId(subscription.customer) !== row.stripe_customer_id ||
      (subscription.metadata?.user_id && subscription.metadata.user_id !== String(userId))) {
    throw paymentError('Subscription ownership could not be verified.');
  }
  return subscription;
}

export function subscriptionValues(subscription) {
  const item = subscription.items?.data?.[0];
  const periodEnd = item?.current_period_end;
  if (!Number.isFinite(periodEnd) || !item?.price?.id || !stripeId(subscription.customer)) {
    throw paymentError('Stripe returned an incomplete subscription record.', 502);
  }
  return [stripeId(subscription.customer), subscription.id, item.price.id,
    subscription.status, new Date(periodEnd * 1000), Boolean(subscription.cancel_at_period_end)];
}

// Match the subscription, not just its customer: delayed events for an older
// subscription must not change the current subscription on this account.
export async function updateSubscription(db, subscription) {
  const values = subscriptionValues(subscription);
  return db.query(`UPDATE subscriptions SET subscription_status = $1,
    current_period_end = $2, cancel_at_period_end = $3, updated_at = NOW()
    WHERE stripe_subscription_id = $4 AND stripe_customer_id = $5`,
  [values[3], values[4], values[5], subscription.id, values[0]]);
}
