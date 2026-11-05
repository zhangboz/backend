import db from '../db.mjs';
import { assertStripeMode, belongsToStripeDeployment, getStripeClient, hasSubscriptionAccess,
  stripeDeploymentId, stripeId, stripeTestOnly, subscriptionValues } from './stripeService.mjs';

const requestOptions = { timeout: 5000, maxNetworkRetries: 0 };
const terminal = new Set(['canceled', 'incomplete_expired']);
const statuses = new Set(['active', 'trialing', 'canceled', 'incomplete', 'incomplete_expired', 'past_due', 'unpaid', 'paused']);
const normalizeEmail = value => String(value || '').trim().toLowerCase();
const baseState = () => ({ subscriptionSource: 'stripe', subscriptionStatus: 'unknown',
  subscriptionVerified: false, subscriptionCheckedAt: null, subscriptionSyncState: 'unavailable',
  currentPeriodEnd: null, cancelAtPeriodEnd: false, canManageSubscription: false,
  canSubscribe: false, subscriptionMessage: null });

function metadataConflicts(object, user, scope) {
  const metadata = object?.metadata || {};
  return (metadata.app && metadata.app !== 'homework-help-ai') ||
    (metadata.deployment_id && metadata.deployment_id !== scope) ||
    (metadata.user_id && metadata.user_id !== String(user.user_id));
}

/** Stripe decides status/access; PostgreSQL holds the identity link and an observed projection.
 * No status TTL or stale-on-error fallback. Only concurrent reads for the same user are coalesced.
 */
export function createSubscriptionResolver({ database = db, getStripe = getStripeClient,
  testOnly = stripeTestOnly, deploymentId = stripeDeploymentId, now = Date.now, logger = console } = {}) {
  const pending = new Map();
  async function resolveOnce(user) {
    let row = null;
    const result = (state, extra = {}) => ({ row, subscription: null, customer: null,
      replacementAllowed: false, state: { ...baseState(), ...state }, ...extra });
    const unknown = (kind, message) => result({ subscriptionSyncState: kind, subscriptionMessage: message });
    try {
      row = (await database.query(`SELECT user_id, stripe_customer_id, stripe_subscription_id, stripe_price_id,
        subscription_status, current_period_end, cancel_at_period_end, updated_at::text AS projection_version
        FROM subscriptions WHERE user_id = $1`, [user.user_id])).rows[0] || null;
      if (!row) return result({ subscriptionStatus: 'inactive', subscriptionSyncState: 'none', canSubscribe: true });
      if (!row.stripe_customer_id || !row.stripe_subscription_id) return unknown('unlinked', 'Your subscription could not be linked to billing. Please contact support.');
      const stripe = getStripe();
      const scope = deploymentId();
      const mode = testOnly();
      let subscription;
      let missing = false;
      try { subscription = await stripe.subscriptions.retrieve(row.stripe_subscription_id, {}, requestOptions); }
      catch (error) { if (error.code === 'resource_missing') missing = true; else throw error; }
      if (subscription) {
        assertStripeMode(subscription, mode);
        if (subscription.id !== row.stripe_subscription_id || stripeId(subscription.customer) !== row.stripe_customer_id || metadataConflicts(subscription, user, scope)) {
          return unknown('foreign', 'This subscription cannot be verified for this account. Please contact support.');
        }
      }
      // Verify the customer before interpreting a missing ID or accepting historical state.
      let customer;
      try { customer = await stripe.customers.retrieve(row.stripe_customer_id, {}, requestOptions); }
      catch (error) {
        if (error.code === 'resource_missing') return unknown('unlinked', 'Your billing account could not be verified. Please contact support.');
        throw error;
      }
      if (customer.deleted) return unknown('unlinked', 'Your billing account could not be verified. Please contact support.');
      assertStripeMode(customer, mode);
      if (customer.id !== row.stripe_customer_id || metadataConflicts(customer, user, scope) ||
          (customer.metadata?.user_id !== String(user.user_id) &&
            (!normalizeEmail(user.email) || normalizeEmail(customer.email) !== normalizeEmail(user.email)))) {
        return unknown('foreign', 'This billing account could not be verified. Please contact support.');
      }
      let otherPendingSubscription = false;
      if (missing || !hasSubscriptionAccess(subscription.status)) {
        // Recover a newer owned subscription after a missed webhook. Never discover
        // subscriptions by email alone, nor claim untagged/foreign subscriptions.
        const all = [];
        let cursor;
        for (let page = 0; ; page++) {
          if (page >= 5) throw new Error('SUBSCRIPTION_LIST_LIMIT');
          const batch = await stripe.subscriptions.list({ customer: customer.id, status: 'all', limit: 100,
            ...(cursor ? { starting_after: cursor } : {}) }, requestOptions);
          if (!Array.isArray(batch.data)) throw new Error('INVALID_SUBSCRIPTION_LIST');
          for (const item of batch.data) {
            assertStripeMode(item, mode);
            if (stripeId(item.customer) !== customer.id) throw new Error('SUBSCRIPTION_CUSTOMER_MISMATCH');
            all.push(item);
          }
          if (!batch.has_more) break;
          cursor = batch.data.at(-1)?.id;
          if (!cursor) throw new Error('INVALID_SUBSCRIPTION_CURSOR');
        }
        const owned = all.filter(item => belongsToStripeDeployment(item, scope) && item.metadata.user_id === String(user.user_id));
        const priority = item => hasSubscriptionAccess(item.status) ? 0 : terminal.has(item.status) ? 2 : 1;
        owned.sort((a, b) => priority(a) - priority(b) || (b.created || 0) - (a.created || 0));
        if (owned.length) subscription = owned[0];
        otherPendingSubscription = all.some(item => item.id !== subscription?.id && !terminal.has(item.status));
        if (!subscription) {
          // A 404 alone (wrong key/account/mode) never becomes an inactive subscription.
          if (all.length) return unknown('unlinked', 'An existing subscription needs to be linked to this account. Please contact support.');
          await persist(null);
          return result({ subscriptionStatus: 'inactive', subscriptionSyncState: 'none', subscriptionVerified: true,
            subscriptionCheckedAt: new Date(now()).toISOString(), canSubscribe: true }, { customer, replacementAllowed: true });
        }
      }
      if (!statuses.has(subscription.status)) throw new Error('INVALID_SUBSCRIPTION_STATUS');
      const values = subscriptionValues(subscription);
      const scoped = belongsToStripeDeployment(subscription, scope) && subscription.metadata.user_id === String(user.user_id);
      await persist(subscription);
      return result({ subscriptionStatus: subscription.status, subscriptionSyncState: 'verified', subscriptionVerified: true,
        subscriptionCheckedAt: new Date(now()).toISOString(), currentPeriodEnd: values[4].toISOString(),
        cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end),
        canManageSubscription: scoped && hasSubscriptionAccess(subscription.status),
        canSubscribe: scoped && !otherPendingSubscription && (terminal.has(subscription.status) || subscription.status === 'incomplete'),
        subscriptionMessage: !scoped ? 'Contact support to manage this previous subscription.' : null,
      }, { subscription, customer, replacementAllowed: missing });
    } catch (error) {
      logger.warn?.(JSON.stringify({ event: 'subscription_verification_failed',
        code: typeof error.code === 'string' && /^[a-zA-Z0-9_]{1,64}$/.test(error.code) ? error.code : 'verification_failed' }));
      return unknown('unavailable', 'Subscription status is temporarily unavailable. Please retry.');
    }
    async function persist(subscription) {
      const values = subscription ? subscriptionValues(subscription) : [row.stripe_customer_id, row.stripe_subscription_id,
        row.stripe_price_id, 'inactive', null, false];
      try {
        // Preserve missing identifiers for audit; guard against concurrent relinking.
        await database.query(`UPDATE subscriptions SET stripe_subscription_id = $1, stripe_price_id = $2,
          subscription_status = $3, current_period_end = $4, cancel_at_period_end = $5, updated_at = NOW()
          WHERE user_id = $6 AND stripe_customer_id = $7 AND stripe_subscription_id = $8 AND updated_at = $9::timestamptz
          AND (stripe_subscription_id IS DISTINCT FROM $1 OR stripe_price_id IS DISTINCT FROM $2
            OR subscription_status IS DISTINCT FROM $3 OR current_period_end IS DISTINCT FROM $4
            OR cancel_at_period_end IS DISTINCT FROM $5)`,
        [values[1], values[2], values[3], values[4], values[5], user.user_id, row.stripe_customer_id,
          row.stripe_subscription_id, row.projection_version]);
      } catch {
        // Projection failure does not replace a successful Stripe read with stale DB data.
        logger.warn?.(JSON.stringify({ event: 'subscription_projection_failed' }));
      }
    }
  }
  return { resolve(user) {
    const key = `${user.user_id}:${normalizeEmail(user.email)}`;
    if (pending.has(key)) return pending.get(key);
    const operation = resolveOnce(user).finally(() => { if (pending.get(key) === operation) pending.delete(key); });
    pending.set(key, operation);
    return operation;
  } };
}
export const subscriptionResolver = createSubscriptionResolver();
