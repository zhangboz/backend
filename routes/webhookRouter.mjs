import express from 'express';
import db from '../db.mjs';
import { assertStripeMode, belongsToStripeDeployment, getStripeClient, hasSubscriptionAccess, paymentError,
  stripeDeploymentId, stripeId, stripeTestOnly, subscriptionValues, updateSubscription } from '../services/stripeService.mjs';

const pendingSubscriptions = new Map();

// The local backend has one process. Serialize each subscription's fetch/write
// pair so overlapping deliveries cannot apply an earlier snapshot last.
export function reconcileStripeEvent(event, dependencies) {
  const object = event.data?.object;
  const key = event.type === 'checkout.session.completed' ? stripeId(object?.subscription) : object?.id;
  const previous = pendingSubscriptions.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(() => reconcileStripeEventOnce(event, dependencies));
  pendingSubscriptions.set(key, current);
  return current.finally(() => {
    if (pendingSubscriptions.get(key) === current) pendingSubscriptions.delete(key);
  });
}

async function reconcileStripeEventOnce(event, { stripe, database, testOnly = true, deploymentId = stripeDeploymentId() }) {
  assertStripeMode(event, testOnly);
  if (!['checkout.session.completed', 'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted'].includes(event.type)) return;
  const object = event.data.object;
  // A test account can send the same event to local and cloud endpoints. User IDs
  // alone are not globally unique after copying the database. Untagged historical
  // objects are deliberately not claimed by either deployment.
  if (!belongsToStripeDeployment(object, deploymentId)) return;
  const subscriptionId = event.type === 'checkout.session.completed' ? stripeId(object.subscription) : object.id;
  if (!subscriptionId) throw paymentError('Webhook has no subscription ID.', 400);
  // Retrieve current state so delayed events cannot restore obsolete status.
  const subscription = assertStripeMode(await stripe.subscriptions.retrieve(subscriptionId), testOnly);
  if (!belongsToStripeDeployment(subscription, deploymentId)) return;
  const values = subscriptionValues(subscription);
  const userId = subscription.metadata?.user_id ||
    (event.type === 'checkout.session.completed' ? object.client_reference_id : null);
  const isCheckout = event.type === 'checkout.session.completed';
  const isOwnedCreation = event.type === 'customer.subscription.created' &&
    subscription.metadata?.app === 'homework-help-ai' && userId;
  if (!isCheckout && !isOwnedCreation) {
    await updateSubscription(database, subscription);
    return;
  }
  if (!/^\d+$/.test(String(userId)) ||
      (isCheckout && object.client_reference_id && String(object.client_reference_id) !== String(userId)) ||
      (isCheckout && stripeId(object.customer) !== values[0])) throw paymentError('Webhook subscription ownership could not be verified.', 400);
  const existing = (await database.query(
    'SELECT stripe_subscription_id, stripe_customer_id, subscription_status FROM subscriptions WHERE user_id = $1', [userId])).rows[0];
  if (existing && existing.stripe_customer_id !== values[0]) {
    throw paymentError('A different customer is already linked to this account.');
  }
  let replaceSubscriptionId = null;
  if (existing && existing.stripe_subscription_id !== subscription.id) {
    let old;
    try { old = await stripe.subscriptions.retrieve(existing.stripe_subscription_id); }
    catch (error) {
      if (error.code !== 'resource_missing') throw error;
      // A copied historical mapping can point to a subscription absent from the
      // current Stripe account. Verify its still-existing customer independently;
      // cached active/trialing status is not evidence that this old ID exists.
      let customer;
      try { customer = await stripe.customers.retrieve(existing.stripe_customer_id); }
      catch (customerError) {
        if (customerError.code === 'resource_missing') throw paymentError('The saved Stripe customer could not be verified.');
        throw customerError;
      }
      assertStripeMode(customer, testOnly);
      const user = (await database.query('SELECT user_id, email FROM users WHERE user_id = $1', [userId])).rows[0];
      const email = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
      const tags = customer.metadata || {};
      if (customer.deleted || customer.id !== existing.stripe_customer_id || !email(user?.email) ||
          email(customer.email) !== email(user.email) ||
          (tags.app && tags.app !== 'homework-help-ai') ||
          (tags.deployment_id && tags.deployment_id !== deploymentId) ||
          (tags.user_id && tags.user_id !== String(userId))) {
        throw paymentError('The saved Stripe customer ownership could not be verified.');
      }
    }
    if (old) {
      assertStripeMode(old, testOnly);
      if (!belongsToStripeDeployment(old, deploymentId)) {
        throw paymentError('This subscription belongs to another deployment or predates deployment isolation.');
      }
      if (stripeId(old.customer) !== values[0] || old.metadata?.user_id !== String(userId)) {
        throw paymentError('Subscription ownership could not be verified.');
      }
      // Stripe's current object determines replacement eligibility, even when
      // the local projection still says active after a delayed/missed webhook.
      if (old.created >= subscription.created || hasSubscriptionAccess(old.status)) return;
    }
    replaceSubscriptionId = existing.stripe_subscription_id;
  }
  await database.query(`INSERT INTO subscriptions (user_id, stripe_customer_id, stripe_subscription_id,
    stripe_price_id, subscription_status, current_period_end, cancel_at_period_end)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (user_id) DO UPDATE SET
      stripe_customer_id = EXCLUDED.stripe_customer_id, stripe_subscription_id = EXCLUDED.stripe_subscription_id,
      stripe_price_id = EXCLUDED.stripe_price_id, subscription_status = EXCLUDED.subscription_status,
      current_period_end = EXCLUDED.current_period_end, cancel_at_period_end = EXCLUDED.cancel_at_period_end,
      updated_at = NOW()
    WHERE subscriptions.stripe_subscription_id = EXCLUDED.stripe_subscription_id
       OR (subscriptions.stripe_customer_id = EXCLUDED.stripe_customer_id
           AND subscriptions.stripe_subscription_id = $8)`, [userId, ...values, replaceSubscriptionId]);
}

export function createWebhookRouter({ database = db, getStripe = getStripeClient,
  testOnly = stripeTestOnly, webhookSecret = () => process.env.STRIPE_WEBHOOK_SECRET,
  deploymentId = stripeDeploymentId } = {}) {
  const router = express.Router();
  router.post('/', async (req, res, next) => {
    let event;
    let stripe;
    try {
      stripe = getStripe();
      if (!webhookSecret()) throw paymentError('Local Stripe webhook secret is not configured.', 503);
    } catch (error) { return next(error); }
    try { event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], webhookSecret()); }
    catch { return res.status(400).json({ message: 'Invalid Stripe webhook signature.' }); }
    try {
      await reconcileStripeEvent(event, { stripe, database, testOnly: testOnly(), deploymentId: deploymentId() });
      res.json({ received: true });
    } catch (error) { next(error); }
  });
  return router;
}

export default createWebhookRouter();
