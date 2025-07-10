// paymentRouter.mjs

import express from 'express';
import Stripe from 'stripe';
import db from '../db.mjs';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const router = express.Router();
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

router.post('/create-checkout-session', async (req, res, next) => {
  const { user_id, email } = req.user;
  const { returnPath = '/account' } = req.body; 
  
  const PRICE_ID = process.env.STRIPE_PRICE_ID;
  
  console.log(`[PaymentRouter] Received request to create checkout for user_id: ${user_id} with returnPath: ${returnPath}`);

  try {
    const subResult = await db.query(
      'SELECT stripe_subscription_id, subscription_status, stripe_customer_id FROM subscriptions WHERE user_id = $1',
      [user_id]
    );
    const existingSub = subResult.rows[0];

    if (existingSub?.subscription_status === 'incomplete') {
      console.log(`[PaymentRouter] Found incomplete subscription. Retrieving invoice...`);
      const subscription = await stripe.subscriptions.retrieve(existingSub.stripe_subscription_id, {
        expand: ['latest_invoice'],
      });
      const invoice = subscription.latest_invoice;
      if (invoice && invoice.status === 'open' && invoice.hosted_invoice_url) {
        console.log(`[PaymentRouter] Found open invoice. Returning hosted_invoice_url.`);
        return res.json({ url: invoice.hosted_invoice_url });
      }
    }
    
    const cleanReturnPath = returnPath.startsWith('/') ? returnPath : `/${returnPath}`;
    const successUrl = `${FRONTEND_URL}${cleanReturnPath}?payment=success`;
    const cancelUrl = `${FRONTEND_URL}${cleanReturnPath}`;

    const sessionPayload = {
      payment_method_types: ['card'],
      mode: 'subscription',
      line_items: [{ price: PRICE_ID, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      // --- ADDITION START ---
      // This is the key part for adding a free trial.
      // It instructs Stripe to create the subscription with a 7-day trial period.
      // The customer's card will not be charged until the trial ends.
      subscription_data: {
        trial_period_days: 7,
      },
      // --- ADDITION END ---
    };

    if (existingSub?.stripe_customer_id) {
      sessionPayload.customer = existingSub.stripe_customer_id;
    } else {
      sessionPayload.customer_email = email;
      sessionPayload.client_reference_id = user_id.toString();
    }
    
    const session = await stripe.checkout.sessions.create(sessionPayload);
    res.json({ url: session.url });

  } catch (error) {
    console.error("[PaymentRouter] Error creating/resuming checkout session:", error);
    next(error);
  }
});

// ... rest of the file is unchanged ...
router.post('/cancel-subscription', async (req, res, next) => {
  const { user_id } = req.user;
  try {
    const subResult = await db.query('SELECT stripe_subscription_id FROM subscriptions WHERE user_id = $1 AND subscription_status = $2', [user_id, 'active']);
    const stripeSubscriptionId = subResult.rows[0]?.stripe_subscription_id;
    if (!stripeSubscriptionId) {
      return res.status(404).json({ message: "No active subscription found to cancel." });
    }
    await stripe.subscriptions.update(stripeSubscriptionId, {
      cancel_at_period_end: true,
    });
    res.json({ message: 'Cancellation request sent to Stripe successfully.' });
  } catch (error) {
    console.error("Error sending cancellation request:", error);
    next(error);
  }
});

router.post('/reactivate-subscription', async (req, res, next) => {
  const { user_id } = req.user;
  try {
    const subResult = await db.query('SELECT stripe_subscription_id FROM subscriptions WHERE user_id = $1', [user_id]);
    const stripeSubscriptionId = subResult.rows[0]?.stripe_subscription_id;
    if (!stripeSubscriptionId) {
      return res.status(404).json({ message: "No subscription found to reactivate." });
    }
    await stripe.subscriptions.update(stripeSubscriptionId, {
      cancel_at_period_end: false,
    });
    res.json({ message: 'Reactivation request sent to Stripe successfully.' });
  } catch (error)
  {
    console.error("Error sending reactivation request:", error);
    next(error);
  }
});

export default router;