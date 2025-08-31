### `README.md`

# AI Homework Helper Backend

This is the backend server for the Homework Help AI application, built with Express.js. It features a complete user authentication and Stripe-based subscription system to manage access to premium features.

## Core Functions

The server provides the following main functionalities:

1.  **User Authentication & Account Management (`/api/login`)**:
    *   Handles user registration and login via email and password.
    *   Passwords are encrypted using `bcryptjs`.
    *   Issues JSON Web Tokens (JWT) for authenticating subsequent requests.

2.  **Subscription Management System (`/api/payment`, `/api/user/status`)**:
    *   A complete, webhook-driven system for handling recurring subscriptions via Stripe.
    *   Allows new users to subscribe.
    *   Allows returning users (with `canceled` or `incomplete` subscriptions) to start a new subscription or complete payment.
    *   Handles subscription cancellation (at the end of the billing period) and reactivation.
    *   Provides a dedicated endpoint (`/api/user/status`) for the frontend to fetch the most up-to-date user and subscription status.

3.  **Homework Processing (`/api/process-homework`)**:
    *   Accepts file uploads (images or PDFs).
    *   Uses the Google Gemini AI for analysis and returns a text-based reply.
    *   Deletes the temporary file after processing.

4.  **Premium Feature: Markdown Export (`/api/export`)**:
    *   A subscription-protected feature.
    *   Converts Markdown text to `docx` or `pdf` using Pandoc.
    *   Provides a temporary download link for the generated file.

---

## User Authentication & Subscription System

This is the most critical part of the application. It's designed to be robust, secure, and resilient, with Stripe serving as the ultimate source of truth for all billing information.

### Architectural Overview

*   **Single Source of Truth**: **Stripe is the authority.** The application's database is a *replica* of the subscription status from Stripe. All state changes are driven by Stripe webhooks.
*   **Webhook-Driven Updates**: API endpoints in `paymentRouter.mjs` only *trigger* actions (e.g., tell Stripe to cancel a subscription). The actual database update only occurs when the `webhookRouter.mjs` receives a confirmation event from Stripe. This prevents state inconsistency if an API call to Stripe fails or is delayed.
*   **One Subscription Instance Per User**: The system enforces a policy where a user can have only one subscription record in our database at a time. When a user with a `canceled` subscription re-subscribes, the existing database record is **updated** with the new `stripe_subscription_id`, rather than creating a new user record.
*   **Secure & Stateless Auth**: Authentication is handled by JWTs. The `requireAuth` middleware protects all sensitive endpoints.

### Core Components (Files)

*   **`middleware/auth.mjs`**: Contains the `requireAuth` middleware. It validates the JWT from the `Authorization` header and attaches the user's payload (`user_id`, `email`) to the `req` object.
*   **`routes/loginRouter.mjs`**: Handles `POST /api/login/register` and `POST /api/login/login`. Its only job is to manage user credentials and issue a JWT upon successful login.
*   **`routes/userStatusRouter.mjs`**: Provides `GET /api/user/status`. This is the **single source of truth for the frontend**. It queries the database for the complete, up-to-date user and subscription object and returns it. It is called after login and after any subscription action to keep the UI in sync.
*   **`routes/paymentRouter.mjs`**: The "action trigger" router.
    *   `POST /create-checkout-session`: A smart endpoint that handles new subscriptions, re-subscriptions for canceled users, and directs users with `incomplete` payments to the correct Stripe hosted invoice page.
    *   `POST /cancel-subscription`: Tells Stripe to set `cancel_at_period_end: true`. Does not modify the database.
    *   `POST /reactivate-subscription`: Tells Stripe to set `cancel_at_period_end: false`. Does not modify the database.
*   **`routes/webhookRouter.mjs`**: The "state updater" and the most critical component.
    *   Listens at `POST /api/payment/webhook`.
    *   Verifies the signature to ensure the request is from Stripe.
    *   Handles events like `checkout.session.completed` and `customer.subscription.updated`.
    *   This is the **only part of the application that writes subscription changes** to the database, ensuring data integrity.

### Subscription Lifecycle Flow

1.  **New User Subscription**: User clicks "Subscribe" -> `create-checkout-session` is called -> A new Stripe Customer is created -> User pays -> `checkout.session.completed` webhook fires -> A new row is created in our `subscriptions` table.
2.  **Returning User (Cancelled)**: User clicks "Subscribe" -> `create-checkout-session` is called -> The existing `stripe_customer_id` is found -> User is sent to checkout with their info pre-filled -> User pays -> `checkout.session.completed` webhook fires -> The existing row in our `subscriptions` table is **updated** with the new subscription details.
3.  **Incomplete Payment**: User clicks "Complete Payment" -> `create-checkout-session` is called -> The `incomplete` status is detected -> The endpoint retrieves the `hosted_invoice_url` from Stripe and sends it to the user to complete payment.
4.  **Cancellation**: User clicks "Cancel" -> `cancel-subscription` is called, which tells Stripe -> Stripe sends a `customer.subscription.updated` webhook -> Our webhook updates the `cancel_at_period_end` flag in our database to `true`.
5.  **Reactivation**: User clicks "Reactivate" -> `reactivate-subscription` is called -> Stripe sends a `customer.subscription.updated` webhook -> Our webhook updates the `cancel_at_period_end` flag in our database to `false`.

### Database Schema

*   **`users` table**: Stores `user_id`, `email`, and hashed `password`.
*   **`subscriptions` table**: Linked by `user_id`. Stores `stripe_customer_id`, the current `stripe_subscription_id`, `subscription_status`, `current_period_end`, and `cancel_at_period_end`. The `user_id` is unique, enforcing the "one sub record per user" policy.

---

## Local Development with Docker

This project uses Docker and Docker Compose to create a consistent, isolated, and production-like development environment. This approach ensures that all services (PostgreSQL with pgvector, Redis, and the Node.js app) run exactly the same on any machine, without interfering with system-level installations.

All commands below should be run from the `backend` directory, where the `docker-compose.yml` file is located.

### 1. Starting All Services

This is your main command to fire everything up. You have a few options:

*   **To start and see all logs in your terminal (recommended for debugging):**
    ```bash
    docker-compose up
    ```
    This will take over your terminal window. To stop everything, press `Ctrl + C`.

*   **To start services in the background (detached mode):**
    ```bash
    docker-compose up -d
    ```
    This is useful when you just want the services running so you can work on your code.

*   **To rebuild your app's image after changes:**
    If you change your `Dockerfile` or install new npm packages (`package.json`), you must tell Docker to rebuild the image.
    ```bash
    docker-compose up --build
    ```
    *(You can also combine this with detached mode: `docker-compose up -d --build`)*

### 2. Connecting to the Database

To interact with your PostgreSQL database using `psql`, run the following command. This executes `psql` *inside* the running database container.

```bash
docker-compose exec db psql -U postgres -d homeworkhelpai
```

**Pro Tip:** If you run a query that returns many rows and get stuck at an `(END)` message, simply press **`q`** to quit the pager and return to the `psql>` prompt.

### 3. Other Useful Docker Commands

Here are some other essential commands for managing your local environment:

*   **To stop all running services:**
    (If you started with `docker-compose up -d`)
    ```bash
    docker-compose down
    ```

*   **To stop services AND delete the database data (for a complete reset):**
    This is useful if you want to start completely fresh.
    ```bash
    docker-compose down -v
    ```

*   **To view the logs of all running services:**
    (If you started in detached mode)
    ```bash
    docker-compose logs
    ```

*   **To follow the logs of a specific service in real-time:**
    For example, to watch only the backend's logs:
    ```bash
    docker-compose logs -f backend
    ```

*   **To see the status of your running services:**
    ```bash
    docker-compose ps
    ```

### Typical Local Workflow

1.  **Start of day:** `cd backend` then `docker-compose up -d`.
2.  **Work on code.** Changes to `.mjs` files are reflected automatically thanks to the volume mount.
3.  **Need to check the DB:** `docker-compose exec db psql -U postgres -d homeworkhelpai`.
4.  **Something's wrong?** `docker-compose logs -f backend` to see live error messages.
5.  **Installed a new npm package?** `docker-compose up -d --build` to rebuild the image with the new package.
6.  **End of day:** `docker-compose down`.
7.  **Need to start over from scratch?** `docker-compose down -v`, then `docker-compose up`.
## Important Reminders

*   **Stripe Webhook is CRITICAL**: The application's subscription logic will not function without the Stripe CLI listener running in development. In production, you must configure a permanent webhook endpoint in your Stripe Dashboard.
*   **Database as a Replica**: Remember that the `subscriptions` table is a mirror of Stripe's state. If data seems inconsistent, the first place to check is the Stripe Dashboard for that customer, as it is the source of truth.