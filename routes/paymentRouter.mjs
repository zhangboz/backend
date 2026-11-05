import express from 'express';
import { createHash } from 'node:crypto';
import db from '../db.mjs';
import { createSubscriptionResolver } from '../services/subscriptionState.mjs';
import { assertStripeMode, belongsToStripeDeployment, getStripeClient, hasSubscriptionAccess, paymentError,
  stripeDeploymentId, stripeId, stripeTestOnly, updateSubscription } from '../services/stripeService.mjs';

export function createPaymentRouter({ database = db, getStripe = getStripeClient,
  testOnly = stripeTestOnly, frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000',
  priceId = () => process.env.STRIPE_PRICE_ID, deploymentId = stripeDeploymentId, now = Date.now,
  resolver = createSubscriptionResolver({ database, getStripe, testOnly, deploymentId, now }) } = {}) {
  const router = express.Router();
  const requireKnownState = state => {
    if (!['verified', 'none'].includes(state.subscriptionSyncState)) {
      throw paymentError('Your Stripe subscription could not be verified. Please try again or contact support.',
        state.subscriptionSyncState === 'unavailable' ? 503 : 409);
    }
  };

  router.post('/create-checkout-session', async (req, res, next) => {
    try {
      const stripe = getStripe();
      const scope = deploymentId();
      const userId = req.user.user_id;
      const { state, row, subscription: existing, customer } = await resolver.resolve(req.user);
      requireKnownState(state);
      if (hasSubscriptionAccess(state.subscriptionStatus)) throw paymentError('An active or trial subscription already exists.');
      const returnPath = req.body?.returnPath || '/account';
      if (typeof returnPath !== 'string' || !/^\/(?!\/)/.test(returnPath) || /[\\\r\n]/.test(returnPath)) {
        throw paymentError('Invalid return path.', 400);
      }
      const cancelUrl = new URL(returnPath, frontendUrl);
      if (cancelUrl.origin !== new URL(frontendUrl).origin) throw paymentError('Invalid return path.', 400);
      const successUrl = new URL(cancelUrl);
      successUrl.searchParams.set('payment', 'success');
      if (!state.canSubscribe) throw paymentError('A new subscription cannot be created until your Stripe subscription is resolved.');
      if (existing?.status === 'incomplete') {
        const expanded = assertStripeMode(await stripe.subscriptions.retrieve(existing.id, { expand: ['latest_invoice'] }), testOnly());
        if (!belongsToStripeDeployment(expanded, scope) || expanded.metadata?.user_id !== String(userId) ||
            stripeId(expanded.customer) !== customer?.id) {
          throw paymentError('Subscription ownership could not be verified.');
        }
        const invoice = expanded.latest_invoice;
        if (invoice?.status === 'open' && invoice.hosted_invoice_url) return res.json({ url: invoice.hosted_invoice_url });
        throw paymentError('An incomplete subscription already exists. Complete or expire it in the Stripe test dashboard first.');
      }
      const price = assertStripeMode(await stripe.prices.retrieve(priceId()), testOnly());
      if (!price.active || price.type !== 'recurring') throw paymentError('The configured subscription price is unavailable.', 503);
      const payload = {
        payment_method_types: ['card'], mode: 'subscription',
        line_items: [{ price: price.id, quantity: 1 }],
        success_url: successUrl.toString(), cancel_url: cancelUrl.toString(),
        client_reference_id: String(userId), metadata: { app: 'homework-help-ai', deployment_id: scope, user_id: String(userId) },
        subscription_data: { trial_period_days: 7, metadata: { app: 'homework-help-ai', deployment_id: scope, user_id: String(userId) } },
      };
      if (row?.stripe_customer_id) {
        if (!customer || customer.deleted || customer.id !== row.stripe_customer_id) {
          throw paymentError('Your Stripe customer could not be verified. Please try again or contact support.');
        }
        payload.customer = customer.id;
      } else payload.customer_email = req.user.email;
      // Retry identical requests, but do not reuse Stripe's idempotency key for
      // different return URLs/customer payloads or a later subscription lifecycle.
      const requestHash = createHash('sha256')
        .update(JSON.stringify({ payload, previousSubscriptionId: existing?.id || row?.stripe_subscription_id || null }))
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
        const { state, subscription } = await resolver.resolve(req.user);
        requireKnownState(state);
        if (!state.canManageSubscription || !subscription) {
          throw paymentError('Only a verified active or trial subscription owned by this deployment can be changed.');
        }
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
