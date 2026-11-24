# Deploying on Render

Project Management runs on Render as one Node web service. It connects to Postgres through `DATABASE_URL`, like the other GSC apps: set the environment variables below and the app connects on start. No credentials live in the code.

> **Frontend on Vercel, backend on Render.** Render runs the API and is the only server with database settings. Vercel serves the pages: it forwards every `/api` request to Render, and its server-rendered pages get their data from Render's `/api/pages/...` endpoints (`lib/page-data.ts`). With `BACKEND_URL` set, the database and admin clients refuse to run, so a missed path fails loudly instead of reading another database.

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
| `DATABASE_URL` | Render only | The `project_app` session-pooler string: `postgresql://project_app.<project-ref>:<password>@aws-1-ap-south-1.pooler.supabase.com:5432/postgres?sslmode=require&uselibpqcompat=true`. Secret. Keep both parameters: Node's driver treats a plain `sslmode=require` as full certificate checking, which Supabase's own CA fails |
| `BACKEND_URL` | Vercel only | The Render service's URL (`https://<service>.onrender.com`). Set before the build: Vercel then forwards every `/api` request and `/auth/callback` to Render, and its server-rendered pages load their data from Render, so the browser stays on one origin. Never set it on Render |
| `API_ONLY` | Render only | `1`: Render answers only `/api/...` and `/auth/callback`; a page opened on the Render address is sent to `NEXT_PUBLIC_APP_URL` (the Vercel address). Unset locally |
| `DB_USER_ROLE` | Yes, on the shared database | The role each user request runs as, so row-level security applies: `project_user` there (created at cutover); `authenticated` on a Supabase database of this app's own |
| `DB_ANON_ROLE` | Yes, on the shared database | Signed-out requests: `project_anon` (default `anon`) |
| `DB_SYSTEM_ROLE` | Yes, on the shared database | Server jobs: `project_system`, allowed by explicit policies (unset: the login itself, as on Supabase) |
| `DB_SCHEMA` | Yes, on the shared database | `project`: Prisma models and the query layer use it (default `public`) |
| `DB_STATEMENT_TIMEOUT_MS` | Recommended | Each request's statement timeout, `8000` on the shared database |
| `DB_POOL_MAX` | No | Connections per server, default `5`. All apps and Supabase itself share the plan's limit (60 on the Free plan), so keep the total of every app's servers × `DB_POOL_MAX` well below it |
| `NEXT_PUBLIC_SUPABASE_URL` | Yes | The Supabase project used for sign-in (Supabase Auth); which one is integration decision D4 |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY` | Yes | That project's publishable key |
| `SUPABASE_SERVICE_ROLE_KEY` | Render only | That project's service key: invitations and user administration through Supabase Auth. Secret |
| `NEXT_PUBLIC_APP_URL` | Yes | The app's public address, e.g. `https://project.<company domain>` |
| `CRON_SECRET` | If scheduled jobs run | Long random string. Secret |
| `RESEND_API_KEY` or `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | For email | Secret |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | For file storage in Cloudflare R2 | Secret; without them files go to Supabase Storage |
| `NODE_VERSION` | Yes | `22` |

Locally the same variables come from `.env.development.local` (local Docker database), so nothing changes between machines except the values.

## Vercel (frontend)

Only these, all set before the build: `BACKEND_URL` (the Render URL), `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY`, `NEXT_PUBLIC_APP_URL`. No `DATABASE_URL`, `DB_*`, service key, `CRON_SECRET` or `R2_*`: those stay on Render. Function region: Singapore (`sin1`), next to Render.

Test the split locally: build the backend as usual (`npm run e2e:local:build`) and start it with `PORT=3150 npm run e2e:local:start`; build and start the frontend with `FRONTEND_ONLY=http://127.0.0.1:3150` on the same two commands (port 3100). The suites then run against the frontend unchanged.

## Before the first deploy against the shared database

1. Phase 11 finished: no module uses the Supabase Data API. Done; proved with `tests/local-e2e/data-api-off-proxy.mjs`.
2. Tables in the `project` schema: `prisma/migrations/20261124000000_project_baseline` (policies read the user from `project.current_user_id()` instead of `auth.uid()`, because `project_app` cannot use `auth` there), applied by `project_migrator` with `npx prisma migrate deploy`. Rehearsed locally: `npm run shared-db:rollback-test`, `npm run shared-db:security`.
3. Roles from `db/shared/roles.sql` (run once as postgres): `project_migrator`, and `project_user` / `project_anon` / `project_system` granted to `project_app` without inheritance. Undo: `db/shared/rollback-baseline.sql`, then `db/shared/rollback-roles.sql`.
4. A test connection from a staging service, including TLS to the pooler.
5. Existing data inventoried (`npm run db:inventory`) and migrated, with a backup.
