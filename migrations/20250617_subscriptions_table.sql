-- backend/migrations/20250617_subscriptions_table.sql

-- We wrap the whole migration in a transaction.
-- This means if any part of the script fails, the entire transaction is rolled back,
-- and the database is left in its original state.
BEGIN;

-- Create the subscriptions table
CREATE TABLE subscriptions (
    -- A unique identifier for each subscription record in our database.
    id BIGSERIAL PRIMARY KEY,

    -- Foreign key to the users table.
    -- Each subscription belongs to exactly one user.
    -- The UNIQUE constraint ensures a user can have only one entry in this table,
    -- enforcing a one-to-one relationship.
    -- ON DELETE CASCADE means if a user is deleted, their subscription record is also automatically deleted.
    user_id INTEGER NOT NULL UNIQUE REFERENCES users(user_id) ON DELETE CASCADE,

    -- The ID of the Customer object in Stripe (e.g., 'cus_xxxxxxxxxxxxxx').
    -- This is the link between our user and the Stripe customer.
    -- We add a UNIQUE constraint because a Stripe customer should only be linked to one user.
    stripe_customer_id TEXT NOT NULL UNIQUE,

    -- The ID of the Subscription object in Stripe (e.g., 'sub_xxxxxxxxxxxxxx').
    -- This identifies the specific recurring payment plan.
    -- This is also unique.
    stripe_subscription_id TEXT NOT NULL UNIQUE,
    
    -- The ID of the Price object in Stripe (e.g., 'price_xxxxxxxxxxxxxx').
    -- This tells us which plan the user is on (e.g., Basic, Pro, etc.).
    stripe_price_id TEXT NOT NULL,

    -- A cached copy of the subscription's status from Stripe (e.g., 'active', 'trialing', 'past_due', 'canceled').
    -- Storing this lets us quickly check subscription status without calling the Stripe API.
    subscription_status TEXT NOT NULL,

    -- A cached copy of the timestamp for when the current billing period ends.
    -- Useful for displaying "Access valid until..." in the UI.
    -- We use TIMESTAMPTZ (timestamp with time zone) to avoid time zone issues.
    current_period_end TIMESTAMPTZ NOT NULL,

    -- Timestamps for our own record-keeping.
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Add an index on user_id for faster lookups.
-- While the UNIQUE constraint already creates an index, a separate command makes it explicit.
CREATE INDEX ON subscriptions (user_id);

-- Add an index on status for quickly finding all active or canceled users.
CREATE INDEX ON subscriptions (subscription_status);

-- A trigger to automatically update the updated_at timestamp whenever a row is changed.
-- This is a common and useful pattern in database design.
CREATE OR REPLACE FUNCTION set_updated_at_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_subscriptions_updated_at
BEFORE UPDATE ON subscriptions
FOR EACH ROW
EXECUTE FUNCTION set_updated_at_timestamp();

-- Commit the transaction to make all changes permanent.
COMMIT;