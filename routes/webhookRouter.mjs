import express from 'express';
import Stripe from 'stripe';
import db from '../db.mjs';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const router = express.Router();

router.post('/', async (req, res, next) => {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
        event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        console.error(`❌ Webhook signature verification failed: ${err.message}`);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
        switch (event.type) {
            case 'checkout.session.completed': {
                const session = event.data.object;
                let userId;

                // --- THIS IS THE FIX ---
                // Determine the user ID based on whether it's a new or returning customer.
                if (session.client_reference_id) {
                    // Flow for a brand new customer
                    userId = session.client_reference_id;
                    console.log(`[Webhook] New customer subscribed. User ID from client_reference_id: ${userId}`);
                } else {
                    // Flow for a returning customer
                    const stripeCustomerId = session.customer;
                    if (!stripeCustomerId) {
                        throw new Error('Webhook Error: checkout.session.completed did not have customer or client_reference_id.');
                    }
                    console.log(`[Webhook] Returning customer subscribed. Looking up user for Stripe Customer ID: ${stripeCustomerId}`);
                    
                    // Find our internal user_id from the stripe_customer_id
                    const userResult = await db.query(
                        'SELECT user_id FROM subscriptions WHERE stripe_customer_id = $1',
                        [stripeCustomerId]
                    );
                    if (userResult.rows.length === 0) {
                        throw new Error(`Webhook Error: Could not find user for returning customer ${stripeCustomerId}`);
                    }
                    userId = userResult.rows[0].user_id;
                }
                
                // Now that we have a guaranteed valid userId, the rest of the logic works perfectly.
                const subscription = await stripe.subscriptions.retrieve(session.subscription);
                const periodEndValue = subscription.items.data[0]?.current_period_end;

                await db.query(`
                    INSERT INTO subscriptions (user_id, stripe_customer_id, stripe_subscription_id, stripe_price_id, subscription_status, current_period_end, cancel_at_period_end)
                    VALUES ($1, $2, $3, $4, $5, $6, $7)
                    ON CONFLICT (user_id) DO UPDATE SET
                        stripe_customer_id = EXCLUDED.stripe_customer_id,
                        stripe_subscription_id = EXCLUDED.stripe_subscription_id,
                        stripe_price_id = EXCLUDED.stripe_price_id,
                        subscription_status = EXCLUDED.subscription_status,
                        current_period_end = EXCLUDED.current_period_end,
                        cancel_at_period_end = EXCLUDED.cancel_at_period_end;
                `, [
                    userId,
                    subscription.customer,
                    subscription.id,
                    subscription.items.data[0].price.id,
                    subscription.status,
                    periodEndValue ? new Date(periodEndValue * 1000) : null,
                    subscription.cancel_at_period_end
                ]);
                console.log(`[Webhook] Processed '${event.type}' for user_id: ${userId}.`);
                break;
            }

            case 'customer.subscription.updated':
            case 'customer.subscription.deleted': {
                const subscription = await stripe.subscriptions.retrieve(event.data.object.id);
                const userResult = await db.query('SELECT user_id FROM subscriptions WHERE stripe_customer_id = $1', [subscription.customer]);
                
                if (userResult.rows.length > 0) {
                    const userId = userResult.rows[0].user_id;
                    const periodEndValue = subscription.items.data[0]?.current_period_end;
                    await db.query(`
                        UPDATE subscriptions SET
                            subscription_status = $1,
                            current_period_end = $2,
                            cancel_at_period_end = $3
                        WHERE user_id = $4
                    `, [
                        subscription.status,
                        periodEndValue ? new Date(periodEndValue * 1000) : null,
                        subscription.cancel_at_period_end,
                        userId
                    ]);
                    console.log(`[Webhook] Processed '${event.type}' for user_id: ${userId}. Status: ${subscription.status}, Cancel at end: ${subscription.cancel_at_period_end}`);
                }
                break;
            }
        }
    } catch (dbError) {
        console.error(`[Webhook] Error processing event ${event.type}:`, dbError);
        // Let the global error handler manage the response, but return to stop execution
        return next(dbError);
    }

    res.status(200).send({ received: true });
});

export default router;