# Homework Help AI backend — OpenAI edition

Express API for homework help, handwriting transcription, speech, authentication, Stripe TEST subscriptions and model-generated PDF/DOCX exports. This component belongs to the [private parent project](https://github.com/zhangboz/homework-help-ai); it also runs independently.

## Status — 2026-11-04

The current cloud target is **a new Render Free Node API with Neon Free PostgreSQL**. The parent [render.yaml](https://github.com/zhangboz/homework-help-ai/blob/main/render.yaml) and [deployment guide](https://github.com/zhangboz/homework-help-ai/blob/main/deploy/render/README.md) describe the prepared configuration. No cloud resources have been created or deployed and no DNS cutover has occurred. The retired Render system remains archived and inactive.

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

The bilingual prototype preserved Chinese, code, tables and math without Pandoc. Word equations currently use images rather than editable native math. Model formatting still needs quality checks for long documents and uncommon notation; this is not a deterministic conversion endpoint. OpenAI maintains the execution environment, while this API owns authorization, persistence, bounds and cleanup.

## Login, mail and health

Production Google OAuth state uses PostgreSQL with a ten-minute TTL. The final login remains JWT-based. Retain the local callback `http://localhost:5000/api/login/auth/google/callback` when adding a new deployment URL.

Render Free blocks common SMTP ports, so production mail uses `EMAIL_PROVIDER=resend`, `RESEND_API_KEY` and `MAIL_FROM` from a verified owned domain. Local SMTP still uses the existing configuration. Domain verification and real cloud email acceptance remain pending. See [Render network limitations](https://render.com/docs/free) and [Resend domain verification](https://resend.com/docs/dashboard/domains/introduction).

Run `npm run local:stripe` for local TEST webhook forwarding, then restart the API if necessary to load its current secret. Cloud tests need a separate TEST endpoint and signing secret. Use a new fixture customer; do not repurpose historical live/test subscriptions or enable live billing.

`GET /api/health` checks process liveness without querying PostgreSQL and is the Render health-check path. Use `GET /api/ready` manually to check database/runtime tables; do not point uptime monitoring at it. The database pool has five connections maximum and a ten-second idle timeout so idle Neon compute can sleep.

## Preserved concept feature

The existing concept-explanation changes are preserved in this working tree. `POST /api/concept-explanations/start` binds a selected passage to its original result and browser channel; one follow-up is allowed. A third submission returns the fixed limit message without a model call. Refused selections stop after a tool-free check; eligible explanations use bounded web research and source annotations. Markdown context export includes the original question media, answer, selection and conversation.

Media/answers remain in bounded single-process memory for 30 minutes (64 MB / 64 contexts, eight channels per result), with idle cleanup. Concept messages are not persisted to SQL/disk and use OpenAI `store: false`. Replacing a selection or closing the panel deletes its messages and cancels in-flight work; late responses cannot restore them. Restart/expiry/eviction requires regenerating the result. Keep one API process until an equivalent shared store is implemented.

## Validation and history

Run `npm test` for offline tests. Current backend checks pass, including export restart recovery, ownership, duplicate dispatch prevention, bounds and provider cleanup. Native Windows smoke checks used Node 23; deployment targets Node 24. Explicit `--live` smoke scripts make paid API calls or Stripe TEST fixtures and write only synthetic reports under ignored `.local/`.

The earlier restoration validated owner-confirmed email/Google login and Stripe TEST flows; the recorded 36 original users and 28 subscriptions were historical before/after checks, not a current cloud audit. New cloud database restore, email delivery, OAuth and Stripe acceptance remain pending. See the parent deployment guide rather than retired Oracle/Pandoc instructions.

Active Git history was sanitized on 2026-11-04. The [original backend repository](https://github.com/zhangboz/backend-private-archive-20261104) remains a private read-only archive. Re-clone if your checkout predates cleanup; never push old branches, local backups, dumps, credential exports or user documents. History cleanup does not revoke previously exposed credentials. Local private data remains preserved.

## Render/Neon candidate verification — 2026-11-04

- All 108 backend tests passed in the isolated Node 24 Linux production image; all 31 React tests and the production frontend build passed.
- Eleven real local PostgreSQL checks passed, including concurrent quotas, idempotency, poll leases, session expiry and cleanup. Existing 38 users and 30 subscriptions had identical before/after fingerprints; the temporary test schema was removed.
- Actual HTTP exports produced PDF and DOCX from synthetic bilingual Markdown. Duplicate creation reused one job; PDF completed after an API restart, and signed download tampering was rejected. Generation is model-driven; Word equations may be images rather than native editable math.
- The Render Blueprint passed the official schema check and declares only a Free API plus a static site. The production Docker context is an allowlist; it excludes local data, environment files, keys, backups and retired converters.
- Gitleaks and exact current-secret comparison found no leaks in the candidate source. Secrets and test artifacts remain local and ignored.
- Candidate branch: `codex/render-neon-free`. Cloud resources, Neon data restoration, Resend verification and cloud OAuth/Stripe acceptance remain pending. This does not redeploy the archived Render services or change DNS.
