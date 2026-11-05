# Homework Help AI backend — OpenAI edition

Express API for homework help, handwriting transcription, speech, authentication, Stripe TEST subscriptions and model-generated PDF/DOCX exports. This component belongs to the [private parent project](https://github.com/zhangboz/homework-help-ai); it also runs independently.

## Status — 2026-11-04

The new **Render Free Node API with Neon Free PostgreSQL** is deployed for testing. The [API health endpoint](https://synapse-openai-api.onrender.com/api/health) and [React website](https://synapse-openai-web.onrender.com) are live. The parent [render.yaml](https://github.com/zhangboz/homework-help-ai/blob/codex/render-neon-free/render.yaml) and [deployment guide](https://github.com/zhangboz/homework-help-ai/blob/codex/render-neon-free/deploy/render/README.md) record the configuration and remaining browser/email acceptance. All seven database tables restored with matching data fingerprints; local data remains intact. The custom website domain has not been switched. The retired Render system remains archived and inactive.

Oracle is paused after Phoenix Always Free `OUT_OF_HOST_CAPACITY` results; no VM was created. Gemini, Vertex and Google ADK are retired from runtime, with original prompts retained in `AI_ChatBot/prompts.mjs`. GCS textbook storage/transcription remains paused. Local data and the separate WeChat frontend are preserved.

## Runtime

| Feature | Implementation |
| --- | --- |
| Homework answer | Official OpenAI SDK, Responses API, `gpt-6.1-terra`, medium reasoning |
| Explanation and handwriting transcription | `gpt-6.1-terra`, low reasoning; two-step answer/explanation, single-step transcription |
| Document exports | `gpt-6.1-terra` + hosted Code Interpreter, low reasoning |
| Speech | `gpt-realtime-2.1-mini` WebSocket PCM → WAV; default `marin` |
| Selected concepts | Existing `gpt-6-luna` working-tree feature |
| Durable state | PostgreSQL, including export jobs/files and ten-minute production OAuth state |
| Email | Resend HTTPS in production; SMTP locally |
| Payments | Stripe TEST; seven-day trial, valid `active` or `trialing` access |

The active runtime needs no Redis, BullMQ worker, Pandoc or TeX. Retired native conversion code and the Word template are preserved in [archive/pandoc](archive/pandoc/README.md), excluded from the production image and never used as fallback. Existing local export files and Redis volumes are untouched.

Images/PDFs are sent without GCS. Homework keeps `{success, reply1, reply2}`; a failed second step preserves the answer with `reply2: null` and a warning. Speech failure also preserves the answer.

## Local setup

Use Node 24 LTS and the existing PostgreSQL database. In the complete checkout, install sibling frontend dependencies with `npm ci`, then from `backend/`:

```powershell
npm ci
npm run local:backup
npm run db:migrate
npm run local:start
npm run local:check
```

`db:migrate` runs only the additive allowlisted `migrations/20261104_cloud_runtime.sql`. Do not replay older migrations or schema dumps: some are destructive. Preserve the existing local database at `127.0.0.1:3001` and back it up first.

The launcher starts only the API and React in hidden native Node processes and writes logs under ignored `.local/`. No Docker startup is needed. `local:stop` preserves PostgreSQL/data; `local:restart-api` restarts only the API. For standalone use, `npm start` runs the API after migration. Render uses `npm run start:render`, which runs the same additive migration before starting the server.

Local `.env` loads before `.env.local`; production/tests use supplied environment only. See [.env.example](.env.example). Keep secrets in backend configuration, never frontend variables, Git, logs or Docker build arguments. Production uses a TLS-verified Neon pooled `DATABASE_URL`, `DB_SSL=true`, matching frontend/backend URLs and `TRUST_PROXY_HOPS=1` behind Render's proxy.

## Export lifecycle and limits

`services/openaiExports.mjs` dispatches OpenAI background Responses with `store: true`. Each job receives its own 1 GB container, networking disabled, expiring after 20 idle minutes. Final file citations select the output; files are downloaded into PostgreSQL before provider resources are deleted. Provider cleanup retries are persisted. A service restart can resume an existing response ID without creating a second model run. The browser restores pending tasks after refresh and permits up to ten minutes of polling. See [OpenAI Code Interpreter](https://developers.openai.com/api/docs/guides/tools-code-interpreter).

| Limit | Value |
| --- | --- |
| Markdown source | 64 KB UTF-8 |
| Pending jobs | 2 per user; 8 globally |
| Daily exports | 30 per user |
| File size / total temporary bytes | 8 MB / 64 MB |
| Pending-job deadline | 10 minutes |
| Signed download / file expiry | 15 minutes / 1 hour after completion |

Status access checks ownership. Downloads require valid signatures and expiry. Expired file bytes are removed lazily at startup or on later user activity; there is no periodic database polling worker. Safe errors do not disclose uploaded content or provider diagnostics. An expired or failed export leaves the homework answer intact.

Actual cloud bilingual samples preserved Chinese, code, tables and math without Pandoc. The Word sample contained three native equations; other runs may use equation images. Model formatting still needs quality checks for long documents and uncommon notation; this is not a deterministic conversion endpoint. OpenAI maintains the execution environment, while this API owns authorization, persistence, bounds and cleanup.

## Login, mail and health

Production Google OAuth state uses PostgreSQL with a ten-minute TTL. The final login remains JWT-based. Retain the local callback `http://localhost:5000/api/login/auth/google/callback` when adding a new deployment URL.

Render Free blocks common SMTP ports, so production mail uses `EMAIL_PROVIDER=resend`, `RESEND_API_KEY` and `MAIL_FROM` from a verified owned domain. The sender domain `notify.synapse-education.xyz` is verified, its domain-scoped Sending access key is deployed only on the API, and production configuration validation passed. The owner confirmed actual email receipt, confirmation and password login on the cloud website. Local SMTP still uses the existing configuration. See [Render network limitations](https://render.com/docs/free) and [Resend domain verification](https://resend.com/docs/dashboard/domains/introduction).

Run `npm run local:stripe` for local TEST webhook forwarding, then restart the API if necessary to load its current secret. Cloud tests need a separate TEST endpoint and signing secret. Use a new fixture customer; do not repurpose historical live/test subscriptions or enable live billing.

Keep `STRIPE_DEPLOYMENT_ID=local` for the local database and use `synapse-render` for the Render/Neon deployment. Production requires this setting explicitly. Checkout and subscriptions carry the deployment identity in Stripe metadata. Webhooks acknowledge events from other deployments or untagged historical objects without reading/writing application records; the current Stripe subscription must also match. Cancellation, restoration and Checkout reuse reject foreign or untagged historical subscriptions rather than claiming them. Existing database records remain unchanged; create new test accounts for the deployment's billing acceptance.

`GET /api/health` checks process liveness without querying PostgreSQL and is the Render health-check path. Use `GET /api/ready` manually to check database/runtime tables; do not point uptime monitoring at it. The database pool has five connections maximum and a ten-second idle timeout so idle Neon compute can sleep.

## Preserved concept feature

The existing concept-explanation changes are preserved in this working tree. `POST /api/concept-explanations/start` binds a selected passage to its original result and browser channel; one follow-up is allowed. A third submission returns the fixed limit message without a model call. Refused selections stop after a tool-free check; eligible explanations use bounded web research and source annotations. Markdown context export includes the original question media, answer, selection and conversation.

Media/answers remain in bounded single-process memory for 30 minutes (64 MB / 64 contexts, eight channels per result), with idle cleanup. Concept messages are not persisted to SQL/disk and use OpenAI `store: false`. Replacing a selection or closing the panel deletes its messages and cancels in-flight work; late responses cannot restore them. Restart/expiry/eviction requires regenerating the result. Keep one API process until an equivalent shared store is implemented.

## Validation and history

Run `npm test` for offline tests. Current backend checks pass, including export restart recovery, ownership, duplicate dispatch prevention, bounds and provider cleanup. Native Windows smoke checks used Node 23; deployment targets Node 24. Explicit `--live` smoke scripts make paid API calls or Stripe TEST fixtures and write only synthetic reports under ignored `.local/`.

The earlier restoration validated owner-confirmed local email/Google login. The cloud migration verified all seven tables, including the current source's 38 users and 30 subscriptions, and preserved local data. Cloud API tests passed login, image homework, speech, PDF/DOCX and Stripe TEST trial/cancellation/restoration; the owner also confirmed Google browser login and actual email registration/confirmation/password login. Hosted Checkout browser acceptance remains tracked separately in the parent deployment guide.

Active Git history was sanitized on 2026-11-04. The [original backend repository](https://github.com/zhangboz/backend-private-archive-20261104) remains a private read-only archive. Re-clone if your checkout predates cleanup; never push old branches, local backups, dumps, credential exports or user documents. History cleanup does not revoke previously exposed credentials. Local private data remains preserved.

## Render/Neon candidate verification — 2026-11-04

- All 108 backend tests passed in the isolated Node 24 Linux production image; all 31 React tests and the production frontend build passed.
- Eleven real local PostgreSQL checks passed, including concurrent quotas, idempotency, poll leases, session expiry and cleanup. Existing 38 users and 30 subscriptions had identical before/after fingerprints; the temporary test schema was removed.
- Actual HTTP exports produced PDF and DOCX from synthetic bilingual Markdown. Duplicate creation reused one job; PDF completed after an API restart, and signed download tampering was rejected. Generation is model-driven; Word equations may be images rather than native editable math.
- The Render Blueprint passed the official schema check and declares only a Free API plus a static site. The production Docker context is an allowlist; it excludes local data, environment files, keys, backups and retired converters.
- Gitleaks and exact current-secret comparison found no leaks in the candidate source. Secrets and test artifacts remain local and ignored.
- Deployed branch: `codex/render-neon-free`, with automatic deployment off. Cloud restoration and API-level acceptance passed; all 114 backend tests passed after adding Stripe deployment isolation. Sender-domain verification, mail configuration and owner-confirmed email receipt/confirmation/login are complete; Hosted Checkout browser acceptance remains pending. This does not reactivate the archived Render services or switch the website's custom domain.
