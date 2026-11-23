# Deploying on Render

Project Management runs on Render as one Node web service. It connects to Postgres through `DATABASE_URL`, like the other GSC apps: set the environment variables below and the app connects on start. No credentials live in the code.

> **Not ready for the shared GrowSpark database yet.** Phase 11 is done: the app no longer uses the Supabase Data API (tested with it switched off), so `DATABASE_URL` must be set. Deploy against the shared database only after the remaining steps at the end of this page, and after approval.

## Service

| Setting | Value |
| --- | --- |
| Type | Web Service, Node |
| Build command | `npm ci && npm run build` (installing also generates the Prisma client) |
| Start command | `npm start` (listens on the `PORT` Render provides) |
| Node version | 22 (set `NODE_VERSION=22`) |

## Environment variables

`NEXT_PUBLIC_*` values are built into the browser code, so set them before the build. Mark every secret as secret in Render, and never commit them.

| Variable | Required | Value |
| --- | --- | --- |
| `DATABASE_URL` | Yes | The `project_app` session-pooler string: `postgresql://project_app.<project-ref>:<password>@aws-1-ap-south-1.pooler.supabase.com:5432/postgres`. Secret |
| `DB_USER_ROLE` | Yes, on the shared database | The role each user request runs as, so row-level security applies: `project_user` there (created at cutover); `authenticated` on a Supabase database of this app's own |
| `DB_POOL_MAX` | No | Connections per server, default `5`. All apps and Supabase itself share the plan's limit (60 on the Free plan), so keep the total of every app's servers × `DB_POOL_MAX` well below it |
| `NEXT_PUBLIC_SUPABASE_URL` | Yes | The Supabase project used for sign-in (Supabase Auth); which one is integration decision D4 |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY` | Yes | That project's publishable key |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes, for now | That project's service key: invitations and user administration through Supabase Auth. Secret |
| `NEXT_PUBLIC_APP_URL` | Yes | The app's public address, e.g. `https://project.<company domain>` |
| `CRON_SECRET` | If scheduled jobs run | Long random string. Secret |
| `RESEND_API_KEY` or `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | For email | Secret |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | For file storage in Cloudflare R2 | Secret; without them files go to Supabase Storage |
| `NODE_VERSION` | Yes | `22` |

Locally the same variables come from `.env.development.local` (local Docker database), so nothing changes between machines except the values.

## Before the first deploy against the shared database

1. Phase 11 finished: no module uses the Supabase Data API. Done; proved with `tests/local-e2e/data-api-off-proxy.mjs`.
2. Tables moved into the `project` schema; policies read the signed-in user from a function in `project` instead of `auth.uid()`, because `project_app` cannot use the `auth` schema there.
3. A `project_user` role (no login, no row-level security bypass, access to `project` only) granted to `project_app`, and `DB_USER_ROLE=project_user`.
4. A test connection from a staging service, including TLS to the pooler.
5. Existing data inventoried (`npm run db:inventory`) and migrated, with a backup.
