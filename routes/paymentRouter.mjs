import express from 'express';
import { createHash } from 'node:crypto';
import db from '../db.mjs';
import { assertStripeMode, getStripeClient, hasSubscriptionAccess, paymentError,
  retrieveOwnedSubscription, stripeDeploymentId, stripeTestOnly, updateSubscription } from '../services/stripeService.mjs';

export function createPaymentRouter({ database = db, getStripe = getStripeClient,
  testOnly = stripeTestOnly, frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000',
  priceId = () => process.env.STRIPE_PRICE_ID, deploymentId = stripeDeploymentId, now = Date.now } = {}) {
  const router = express.Router();
  const rowFor = async userId => (await database.query(
    'SELECT stripe_subscription_id, subscription_status, stripe_customer_id, cancel_at_period_end FROM subscriptions WHERE user_id = $1',
    [userId])).rows[0];

  router.post('/create-checkout-session', async (req, res, next) => {
    try {
      const stripe = getStripe();
      const scope = deploymentId();
      const userId = req.user.user_id;
      const row = await rowFor(userId);
      let existing;
      if (row?.stripe_subscription_id) {
        existing = await retrieveOwnedSubscription(stripe, row, userId, testOnly(), scope);
        if (hasSubscriptionAccess(existing.status)) throw paymentError('An active or trial subscription already exists.');
      }
      const price = assertStripeMode(await stripe.prices.retrieve(priceId()), testOnly());
      if (!price.active || price.type !== 'recurring') throw paymentError('The configured subscription price is unavailable.', 503);
      const returnPath = req.body?.returnPath || '/account';
      if (typeof returnPath !== 'string' || !/^\/(?!\/)/.test(returnPath) || /[\\\r\n]/.test(returnPath)) {
        throw paymentError('Invalid return path.', 400);
      }
      const cancelUrl = new URL(returnPath, frontendUrl);
      if (cancelUrl.origin !== new URL(frontendUrl).origin) throw paymentError('Invalid return path.', 400);
      const successUrl = new URL(cancelUrl);
      successUrl.searchParams.set('payment', 'success');
      if (existing?.status === 'incomplete') {
        const expanded = await stripe.subscriptions.retrieve(existing.id, { expand: ['latest_invoice'] });
        const invoice = expanded.latest_invoice;
        if (invoice?.status === 'open' && invoice.hosted_invoice_url) return res.json({ url: invoice.hosted_invoice_url });
        throw paymentError('An incomplete subscription already exists. Complete or expire it in the Stripe test dashboard first.');
      }
      const payload = {
        payment_method_types: ['card'], mode: 'subscription',
        line_items: [{ price: price.id, quantity: 1 }],
        success_url: successUrl.toString(), cancel_url: cancelUrl.toString(),
        client_reference_id: String(userId), metadata: { app: 'homework-help-ai', deployment_id: scope, user_id: String(userId) },
        subscription_data: { trial_period_days: 7, metadata: { app: 'homework-help-ai', deployment_id: scope, user_id: String(userId) } },
      };
      if (row?.stripe_customer_id) {
        let customer;
        try { customer = await stripe.customers.retrieve(row.stripe_customer_id); }
        catch (error) {
          if (error.code === 'resource_missing') throw paymentError('Historical Stripe customer cannot be used in test mode. Use a new local test account.');
          throw error;
        }
        assertStripeMode(customer, testOnly());
        if (customer.deleted) throw paymentError('The saved Stripe customer no longer exists. Use a new local test account.');
        payload.customer = customer.id;
      } else payload.customer_email = req.user.email;
      // Retry identical requests, but do not reuse Stripe's idempotency key for
      // different return URLs/customer payloads or a later subscription lifecycle.
      const requestHash = createHash('sha256')
        .update(JSON.stringify({ payload, previousSubscriptionId: existing?.id || null }))
        .digest('hex').slice(0,32);
      const key = `local-checkout-${userId}-${requestHash}-${Math.floor(now() / 600000)}`;
      const session = assertStripeMode(await stripe.checkout.sessions.create(payload, { idempotencyKey: key }), testOnly());
      res.json({ url: session.url });
    } catch (error) { next(error); }
  });

  for (const [path, cancel] of [['cancel-subscription', true], ['reactivate-subscription', false]]) {
    router.post(`/${path}`, async (req, res, next) => {
      try {
        const stripe = getStripe();
        const scope = deploymentId();
        const row = await rowFor(req.user.user_id);
        if (!row?.stripe_subscription_id) throw paymentError('No subscription found.', 404);
        const subscription = await retrieveOwnedSubscription(stripe, row, req.user.user_id, testOnly(), scope);
        if (!hasSubscriptionAccess(subscription.status)) throw paymentError('Only an active or trial subscription can be changed.');
        if (!cancel && !subscription.cancel_at_period_end) throw paymentError('The subscription is not scheduled for cancellation.');
        const updated = assertStripeMode(await stripe.subscriptions.update(subscription.id, { cancel_at_period_end: cancel }), testOnly());
        await updateSubscription(database, updated);
        res.json({ message: cancel ? 'Subscription will end at the end of its current period.' : 'Subscription reactivated.' });
      } catch (error) { next(error); }
    });
  }
  return router;
}

export default createPaymentRouter();
