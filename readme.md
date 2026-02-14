
# HomeworkHelpAI - backend

---

## 📖 Project Overview

This repository represents a full-stack academic assistance platform designed to process complex student queries (images and text) using Multi-Modal LLM Agents.

Built using an **AI-Assisted Development methodology**, this project moves beyond simple API wrappers. It implements a distributed architecture featuring asynchronous worker queues for heavy computation, a serverless RAG (Retrieval-Augmented Generation) pipeline for textbook ingestion, and a secure payment/subscription infrastructure.

**Core Value Proposition:**
*   **Multi-Agent Reasoning:** Uses a custom Google Vertex AI Agent chain to "Solve" then "Rephrase" answers for TTS (Text-to-Speech) suitability.
*   **Hybrid Database:** Combines relational data (User/Subscription) with Vector embeddings (Textbooks) in PostgreSQL.
*   **Scalable Architecture:** Decouples CPU-intensive tasks (document conversion) from the main event loop.

---

## 🛠 Tech Stack

*   **Backend:** Node.js (ESM), Express.js
*   **Database:** PostgreSQL (with `pgvector` for RAG), managed via SQL migrations.
*   **AI & ML:** Google Vertex AI (Reasoning Engine), Gemini 1.5 Pro/Flash, Google GenAI SDK.
*   **Cloud Infrastructure:** Google Cloud Platform (Cloud Run, Cloud Functions, GCS), Render (Web Services + Redis).
*   **Queue/Async:** BullMQ (Redis-backed) for job processing.
*   **Containerization:** Docker (for Pandoc environment).
*   **Payments & Auth:** Stripe (Webhooks), Passport.js (Google OAuth/JWT).

---

## 🏗 System Architecture & Design Decisions

This system was architected to handle long-running processes without blocking the main application thread.

### 1. The Core Server (`server.mjs`)
The main entry point handles HTTP traffic, authentication, and orchestrates services.
*   **Authentication:** Implements a dual-strategy system using `passport-google-oauth20` and local Email/Password with JWT issuance.
*   **Stripe Integration:** Handles complex subscription lifecycles (Creation, Cancellation, Reactivation) via Webhooks (`webhookRouter.mjs`) to ensure database state always matches payment status.

### 2. Agentic AI Workflow (`GoogleAI_Agent.mjs` & `reasoningEngineClient.mjs`)
Instead of a single API call, the system uses the **Google Agent Development Kit**.
*   **Logic:** The system creates a session with a specific Agent ID deployed on Vertex AI.
*   **Chain:** The input image is analyzed for mathematical correctness. The output is then fed into a secondary logic flow to structure it for audio synthesis.
*   **Why this approach?** It allows for stateful reasoning and separation of concerns (Solving vs. Presenting) compared to a stateless LLM call.

### 3. Distributed Document Conversion (`worker.mjs` & `fileExport.mjs`)
Converting Markdown to PDF/Docx using **Pandoc** is CPU-intensive and can crash a standard Node.js event loop under load.
*   **Solution:** I implemented a **Producer-Consumer pattern**. The main server pushes a job to a Redis queue.
*   **The Worker:** A separate Node process (running in a Docker container with Pandoc binaries installed) picks up the job, performs the conversion, and uploads the result to a dedicated Google Cloud Storage bucket.
*   **Result:** The main server remains responsive to HTTP requests even while generating heavy documents.

### 4. Serverless RAG Pipeline (`main.py`)
To enable the AI to answer specific textbook questions, I built a data ingestion pipeline.
*   **Trigger:** When a textbook PDF is uploaded to a specific GCS Bucket.
*   **Compute:** A **Google Cloud Function** (Python) triggers automatically.
*   **Logic:** It parses the PDF, chunks the text, generates Vector Embeddings using the Gemini Embedding model, and prepares them for insertion into the Vector Database.
*   **Status:** *Note: This feature demonstrates serverless deployment logic, though full-scale indexing of 20+ textbooks is currently paused due to token cost constraints.*

---

## 📂 Project Structure Highlights

```bash
backend/
├── server.mjs                  # Main Express application entry point
├── middleware/
│   ├── auth.mjs                # JWT & Role-based protection
│   └── webhookAuth.mjs         # Security verification for external hooks
├── routes/
│   ├── processHomeworkRouter.mjs # Handles image uploads & Agent orchestration
│   ├── paymentRouter.mjs       # Stripe Checkout session logic
│   └── adminRouter.mjs         # Protected admin routes
├── AI_ChatBot/
│   ├── GoogleAI_Agent.mjs      # Logic to interface with Vertex AI Agents
│   └── reasoningEngineClient.mjs # Client for custom Agent sessions
├── FileProcessor/
│   └── worker.mjs              # Dedicated worker for Pandoc/Export tasks
│   └── fileExport.mjs          # Spawns Pandoc child processes
└── db.mjs                      # Database connection pool
```

---


## Local Development Setup

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

To access the online database on Render.
```powershell
psql -d "REMOVED_EXPOSED_OLD_RENDER_URL"   
```

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

---
## 🔮 Future Roadmap

*   **Cost Optimization:** Implement caching for repeated queries to reduce Vertex AI token usage.
*   **Advanced RAG:** Complete the ingestion of the full Statistics textbook library to enable "Open Book" exam capabilities.

---