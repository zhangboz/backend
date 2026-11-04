# Homework Help AI backend — OpenAI edition

Express API for homework help, handwriting transcription, speech, authentication, Stripe test subscriptions, and local document exports. This repository is the `backend/` component of [homework-help-ai](https://github.com/zhangboz/homework-help-ai).

The parent project and Oracle deployment guide are in a private repository; their links require an authorized GitHub account. This component repository remains independently usable.

## Current status — 2026-11-04

- **OpenAI is the active AI provider.** Gemini, Vertex and Google ADK are retired from the runtime. Original prompts are preserved in `AI_ChatBot/prompts.mjs`.
- **Local functionality is restored.** PostgreSQL, Redis/BullMQ, PDF/DOCX conversion, email/Google login and Stripe TEST flows have been validated.
- **Oracle deployment is being tested.** The Linux container configuration has passed local validation, but Phoenix Always Free capacity checks returned `OUT_OF_HOST_CAPACITY`. No Oracle VM has been provisioned; native ARM64 validation and cloud migration remain pending.
- **The legacy Render system is archived and inactive.** These instructions do not re-enable Render, change the existing domain/DNS, or enable live payments.
- **GCS textbook upload and cloud transcription are paused.** Historical files and database records are retained. Core homework processing and exports do not require GCS.

See the [project setup and status](https://github.com/zhangboz/homework-help-ai/blob/main/README.md) and [Oracle deployment guide](https://github.com/zhangboz/homework-help-ai/blob/main/deploy/oracle/README.md).

## Runtime

| Feature | Current implementation |
| --- | --- |
| Homework answers | Official OpenAI Node SDK and Responses API; `gpt-6.1-terra`, medium reasoning |
| Spoken explanation text | Second Responses call to `gpt-6.1-terra`, low reasoning |
| Handwriting transcription | One Responses call to `gpt-6.1-terra`, low reasoning |
| Speech | `gpt-realtime-2.1-mini` over WebSocket, PCM wrapped as WAV; default voice `marin` |
| Persistence | PostgreSQL; preserve the existing database and back it up before migration |
| Export queue | Redis and BullMQ; API and worker share the local export directory |
| PDF / Word | Pandoc and XeLaTeX with an explicit Chinese font |
| Authentication / billing | Email confirmation, Google OAuth and JWT; Stripe remains TEST-only |

Image and PDF inputs are sent through the OpenAI request flow without GCS. Homework responses retain `{success, reply1, reply2}`; if the explanation step fails, the answer remains available and `reply2` is `null` with a warning. Speech failures do not discard an existing answer.

Exports use the existing create-job, status and download endpoints. Status checks enforce job ownership; signed download URLs expire after 15 minutes and files are retained for one hour. Dollar and backslash math delimiters are supported. Embedded Markdown images are currently rejected with a retry explanation; text, formulas, tables and code blocks remain supported.

## Local setup

Use Node 24 LTS, PostgreSQL 16, Docker Desktop (for Redis), Pandoc and XeLaTeX with a Chinese font. For the complete local launcher, keep this checkout at `backend/` beside `web_frontend/` in the main project.

Configure ignored `.env` and `.env.local` files using [.env.example](.env.example). Keep `OPENAI_API_KEY` and all other secrets in the backend. The restored local database uses `127.0.0.1:3001`; do not start a replacement database or run historical SQL snapshots containing destructive statements.

Run `npm ci` once in the sibling `web_frontend/` directory, then run the following from `backend/`:

```powershell
npm ci
npm run local:start
npm run local:check
```

The launcher runs API, worker and React as native Node processes and starts only Redis in Docker. Open [the web app](http://localhost:3000); the [API health check](http://localhost:5000/api/health) checks its dependencies. Logs are stored under ignored `.local/`.

```powershell
npm run local:backup       # Back up the existing database before changes.
npm run local:stripe       # Forward TEST webhooks; complete CLI login if required.
npm run local:restart-api  # Reload the local webhook signing secret after forwarding starts.
npm run local:stop         # Preserve PostgreSQL and stored data.
```

For standalone process management, use `npm start` for the API and `npm run start:worker` for exports after PostgreSQL and Redis are available. Standalone use does not launch the React repository.

In local development, configuration loads `.env` followed by `.env.local`. Production and tests skip those files and use their supplied environment. Production OAuth sessions use Redis; set `TRUST_PROXY_HOPS=1` only when the API is reachable exclusively through one trusted reverse proxy. `EXPORT_CONCURRENCY` defaults to 2 locally and 1 in production.

Google OAuth and Gmail SMTP are independent of the retired Gemini/GCS services. Local Google callback: `http://localhost:5000/api/login/auth/google/callback`. Keep existing callbacks when adding a new deployment callback.

Stripe uses a seven-day trial; valid `active` and `trialing` subscriptions grant premium access. Test with a fresh fixture account and a separate test webhook signing secret. Do not reuse historical customers across Stripe environments or enable live billing as part of this restoration.

## Validation and deployment boundary

```powershell
npm test
$env:RUN_EXPORT_INTEGRATION='1'
node --test test/exports.test.mjs
Remove-Item Env:RUN_EXPORT_INTEGRATION
```

Live smoke scripts require explicit flags and consume API credit or create Stripe TEST fixtures. See the main project guide before running them. Secrets, backups, tokens, uploaded homework and generated reports are excluded from Git and deployment images.

The Oracle rollout is currently **SSH-only private preview**. Local Linux AMD64 checks do not establish ARM64 compatibility or public production readiness. Pandoc sandboxing and disabled TeX shell escape do not provide complete operating-system isolation for arbitrary TeX; that isolation must be completed and verified before exposing public untrusted-input exports. Cloud HTTPS/OAuth/webhook validation and historical database migration also remain pending.
