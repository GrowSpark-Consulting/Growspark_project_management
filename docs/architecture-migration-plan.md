# Architecture migration plan: aligning Project Management with the GSC platform rules

| | |
|---|---|
| **Status** | **Proposal for review. Nothing in this plan has been implemented.** The current architecture stays as it is until this plan is approved. |
| **Date** | 2026-11-20 |
| **Scope** | Six changes required by "GSC Platform: Database and Integration Rules (draft v0.1)": a dedicated `project` schema, backend-only database access, `organization_id`, UUID v7, archive instead of hard delete, and API v1 with standard responses |
| **Out of scope** | New features, and the Sales & CRM and People & HR apps |

The current state was measured from the code on 2026-11-20, not estimated.

---

## 1. Summary

| # | Change | Today | Target | Size | Risk |
|---|---|---|---|---|---|
| 1 | API v1 and standard responses | `/api/...`; 105 of 159 route files return `{ error: "text" }`; 52 use the shared `api()` wrapper | `/api/v1/...`, `{ data, meta? }` / `{ error: { code, message, details?, requestId } }`, pagination, `Idempotency-Key` | Medium | Low |
| 2 | Backend-only database access | 26 browser components and 22 `lib/` services they use query Supabase directly from the browser; row-level security is the guard | Browsers call only the app's API; the Supabase data API is switched off for the app schema; the server uses a direct Postgres connection | **Large** | Medium |
| 3 | Archive instead of delete | 48 `.delete()` calls on 25 tables; only `projects` and `project_assignments` have archive / removed markers | `archived_at` on business tables; deletes become archive; restore where it makes sense | Medium | Low |
| 4 | `organization_id` | Not present anywhere (single company per install) | Column on every business table, from `GSC_ORGANIZATION_ID`; every query filters by it | Medium | Low |
| 5 | UUID v7 | Every `id` defaults to a database-generated v4 | New rows get an app-generated v7; existing IDs never change | Small | Low |
| 6 | Dedicated `project` schema + three logins | 46 tables, 39 functions and 182 policies in `public`; 609 hard-coded `public.` references in SQL | Everything in schema `project`; logins `project_app` / `project_migrator` / `project_readonly`; migration history in `project` | **Large** | **High** |

**Recommended order:** 1, then 2, 3, 4, 5, and 6 last. Each step is shippable on its own and keeps the app working.

- **Change 6 depends on change 2.** Once the data API is off, server code can't use supabase-js for tables any more, so the direct Postgres access layer from change 2 must exist first.
- **Changes 3–5 are cheaper before change 6,** while the code still has one consistent data-access style.

---

## 2. Decisions needed before starting

| # | Decision | Options | Recommendation | Who |
|---|---|---|---|---|
| D1 | Integration hosting | (A) one Postgres instance with schemas `sales`, `project`, `hr`, `platform`; (B) one database per app | **B for Project Management**, at least until SSO. This app uses Supabase Auth and Storage, which are instance-wide services; a separate project avoids mixing its users and files with the other apps. A remains possible later because of change 6. | All three teams (AGREE) |
| D2 | Server-side database library | (a) **Prisma**, as used by the CRM; (b) Drizzle; (c) plain SQL with `postgres` | **Prisma**, to match the CRM: one toolchain for the team, and `prisma migrate deploy` is what the platform rules prescribe. Triggers, functions and policies stay as raw SQL inside Prisma migrations. | You + team |
| D3 | Authentication | Keep Supabase Auth for sign-in (it is not the data API); or move to app-managed sessions | **Keep Supabase Auth** for now. The rules only forbid browser access to the database; SSO comes later and adds `platform_user_id`. | You |
| D4 | Row-level security after change 2 | Keep it (the server sets the user per transaction); or drop it and rely on API checks | **Keep it.** The server sets `request.jwt.claim.sub` per transaction, so all existing policies and the seven rule triggers keep working unchanged as defense in depth. | You |
| D5 | `GSC_ORGANIZATION_ID` value | One fixed UUID for Grow Spark | Agree it once, put it in all three apps' configuration | All three teams (AGREE) |
| D6 | Old `/api/...` paths | Remove at once; or keep as aliases for one release | **Aliases for one release** (expand and contract), then remove | You |

---

## 3. Change 1: API v1 and standard responses

**Target (rules §7):**
- REST under `/api/v1`, JSON only.
- Success: `{ data, meta? }`.
- Errors: `{ error: { code, message, details?, requestId } }`.
- Lists paginated with `page` and `pageSize` (at most 100).
- Inbound integration calls send `Idempotency-Key`.

**Approach:**
1. Extend `lib/api/context.ts`:
   - `ok()` already returns `{ data, meta }`.
   - Change `errorResponse()` to `{ error: { code, message, details, requestId } }`.
   - Add `requestId`: generated per request, returned in the `X-Request-Id` header, and logged.
   - Error codes are stable strings: `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION_FAILED`, `CONFLICT`, `LOCKED`, `RATE_LIMITED`, `INTERNAL`. The existing database code mapping (42501 to 403, 55006 to 409, …) maps onto them.
2. Convert the 107 route files that don't use the `api()` wrapper yet, starting with the older routes under `app/api/projects`, `accounts`, `workflows`, `roles`, `admin` and `clock`. The wrapper already gives authentication, the active-user check, the client/internal split and error mapping.
3. Move routes to `app/api/v1/...` and keep `app/api/...` as one-line re-exports for one release (D6).
4. Add `page`/`pageSize` to list endpoints. Responses carry `meta: { page, pageSize, total }`.
5. Add an `idempotency_keys` table and helper, used first by the endpoints other apps will call (see `docs/events.md`).
6. Update the browser helpers in `lib/client-api.ts` (`apiGet` / `apiSend` / `apiUpload`) to read the new error shape. Update the remaining raw `fetch('/api/...')` calls with a codemod; the UI has 240 call sites.

**Tests:** a contract test per route (status codes, shape of `data` and `error`, pagination limits), plus the existing `api-wiring` suite pointed at `/api/v1`.

**Rollback:** the aliases keep old clients working, so reverting means routing the aliases back.

---

## 4. Change 2: backend-only database access

**Target (rules §6):**
- Browsers never talk to the database.
- The Supabase data API is switched off for the app's schema.
- The service key never reaches a frontend; it already doesn't.

**Measured today:**
- 26 `'use client'` files call `supabase.from(...)` or `.rpc(...)` directly. Examples: `app/projects/page.tsx`, `app/projects/[projectId]/page.tsx`, `app/admin/time-tracking/page.tsx`, `components/account-overview.tsx`, `components/department-*`, `components/clock-out-dialog.tsx`, `components/dashboard/log-time-dialog.tsx`.
- 22 `lib/` services use the browser client and run in the browser when those components import them. Examples: `account-service`, `assignment-service`, `organization-service`, `milestone-service`, `permission-checker`.

**Approach:**
1. **Data access layer.** Add a server-only module (`lib/db/`) using the D2 library over `DATABASE_URL` (pooled) and `DIRECT_URL` (migrations).
   - It provides `withUser(userId, fn)`, which opens a transaction, sets `request.jwt.claim.sub` and `request.jwt.claim.role`, and runs `fn`.
   - `auth.uid()`, every row-level security policy and every rule trigger therefore keep working unchanged (D4).
   - Service-role access becomes `withSystem(fn)` for the few places that need it (notifications, client portal reads).
2. **Endpoints.** For each browser query, add or reuse a `/api/v1` endpoint. Most already exist from the three-portal work; the remaining ones are mainly the older account, department, capacity and time-tracking screens.
3. **Browser code.** Move the 26 components to `apiGet` / `apiSend`. The 22 browser-side services become server-only (`import 'server-only'`) or are deleted where the API replaces them.
4. **Guard.** A lint rule and a test in `tests/db` that fail if a `'use client'` file imports `createClientSupabase` for data. Sign-in through Supabase Auth stays.
5. **Switch off.** Remove the app schema from the Supabase data API's exposed schemas in `supabase/config.toml` (`[api] schemas`) and, later, in the hosted project. Then confirm that a direct REST call with a user session returns an error.

**Risks:**
- Older screens with complex client-side joins, mainly the project page (≈3,000 lines) and account overview, need careful endpoint design.
- Performance needs checking: one API call should replace several browser queries, not multiply them.

**Tests:** run the local end-to-end flows (§9) before and after each screen moves, plus a "no browser data access" test.

---

## 5. Change 3: archive instead of hard delete

**Target (rules §4.6):** business data is archived with `archived_at` and never hard-deleted.

**Measured today:** 48 delete calls on 25 tables.

**Approach by table type:**

| Kind | Tables | Change |
|---|---|---|
| Business records | `projects` (already has `archived_at`), `tasks`, `comments`, `deliverables`, `project_files`, `milestones`, `project_issues`, `project_updates`, `time_entries`, `accounts`, `departments`, `roles`, `workflow_templates`, `project_templates`, `newsletters` | Add `archived_at timestamptz` (and `archived_by`). Deletes become updates. Lists filter `archived_at IS NULL`. Restore actions where users need them (tasks, files, templates). |
| People | `user_profiles` | Already deactivated, not deleted (`is_active`). Remove the remaining hard delete. |
| Memberships and links | `user_roles`, `account_members`, `workflow_node_assignments`, `task_dependencies`, `project_assignments` (already uses `removed_at`) | Use `removed_at` for memberships, so history is kept. Dependencies and node assignments are editing state and can stay hard-deleted (decision listed below). |
| Workflow editing state | `workflow_nodes`, `workflow_connections` | Saving a template rewrites its nodes. Keep as is: running instances use a snapshot (`started_snapshot`). |
| Per-user settings | `user_dashboard_preferences`, `user_availability`, `user_invitations` | Keep deletes (not business data); invitations get `revoked_at`. |

- **Database guard:** a `BEFORE DELETE` trigger on business tables refuses deletes from application logins, so a missed code path fails loudly instead of losing data. Purging stays possible for the migrator login.
- **Storage:** archived files keep their storage object. A separate, documented purge job can remove objects archived more than N days ago. It is off by default.
- **Decision needed:** confirm that dependency links and template-editing rows may stay hard-deleted.

---

## 6. Change 4: `organization_id`

**Target (rules §4.5, §4.8):** every business row has `organization_id`, every query filters by it, and the value comes from `GSC_ORGANIZATION_ID`.

**Approach:**
1. Expand:
   - Add `organization_id uuid` to every business table (all of §5's business, people and membership tables, plus `timesheets`, `task_activity`, `notifications`, `client_feedback`, `workflow_*` instances and history, and `app_settings`).
   - Backfill every existing row with `GSC_ORGANIZATION_ID`.
   - Set `NOT NULL`, add the index `<table>_organization_id_idx`, and default it to the configured organization through a database setting (`app.organization_id`) that is set at connection time.
2. Enforce in the database: row-level security policies add `organization_id = current_setting('app.organization_id')::uuid`, so a missed filter in code returns nothing rather than another organization's data.
3. Enforce in code: the `withUser` / `withSystem` helpers set `app.organization_id`, and all inserts go through helpers that set it.
4. **Seed:** reads `GSC_ORGANIZATION_ID` from the environment.

Multi-company support is not in scope. This only makes rows ready for integration.

---

## 7. Change 5: UUID v7

**Target (rules §4.1):** IDs are UUID v7, generated by the application. IDs never change.

**Approach:**
- Add `lib/ids.ts` with `newId()` (UUID v7, from the `uuid` package v10 or later).
- All server inserts set `id: newId()` explicitly. Database defaults stay as a fallback for SQL-only paths.
- **Exceptions:**
  - `user_profiles.id` must equal the Supabase Auth user id, which Supabase generates. When SSO arrives, the platform identity is linked through `platform_user_id` (rules §8).
  - Existing rows keep their v4 IDs.
- **Guard:** a `tests/db` check that new rows created by the API have version-7 IDs.

---

## 8. Change 6: dedicated `project` schema and three logins

**Target (rules §1, §3, §5, §6):**
- All tables, types, functions, policies and the migration history in schema `project`.
- Logins `project_app` (runtime; read and write in `project` only), `project_migrator` (DDL in `project` only) and `project_readonly` (reporting).
- `search_path = project`.
- Nothing in `public`.

**Approach:**
1. **Prerequisites:** change 2 is done (no supabase-js data access left), and D1 and D2 are decided.
2. **Generated migration:**
   - `CREATE SCHEMA project`.
   - `ALTER TABLE public.x SET SCHEMA project` for each of the 46 tables. This moves data, indexes, constraints, triggers and policies with the table, without copying.
   - Recreate the 39 functions with `project.` references, replacing the 609 `public.` references with `project.`.
   - Create the three roles and grants from rules §6.
3. **Storage and Auth** stay in their own Supabase schemas (`storage`, `auth`).
   - `user_profiles.id` keeps its foreign key to `auth.users`. This is within this app, so it isn't a cross-app foreign key.
   - Supabase's own grants for its internal roles are kept.
4. **Migration history:**
   - Baseline the D2 tool against the moved schema; Prisma uses `?schema=project` and keeps its history table in `project`.
   - Existing Supabase CLI migrations stay as historical files.
   - New migrations are applied only by the migrator login, with `migrate deploy` on shared databases.
5. **Spike first** (rules §9): on a scratch local database, confirm the following:
   - Every object ends up in `project` and nothing is left in `public`.
   - `project_app` can't read another schema.
   - Pooled connections work for runtime and the direct connection for migrations.
   - The full local test suite passes.
6. **Hosted cutover:** done later, once, in a maintenance window, after a backup and a restore rehearsal (rules §11).

**Risks:**
- **This is the riskiest change.** Every function and policy is rewritten, so a missed reference breaks a feature. Mitigation: generate the rewrite mechanically, then run the 178 database checks and the local end-to-end suite (264 API checks, 53 browser checks) against the moved schema before any hosted cutover.

---

## 9. Testing for every change

1. **Local only, in Docker.** Supabase (Postgres 17, Auth, Storage) is started with `npx supabase start`. The app runs on port 3100 against it.
2. **`npm run test:db`.** Today it runs 178 checks: migrations from a clean database, row-level security and trigger rules as real users, schema drift, and API wiring. It is extended for each change: API contract, no browser data access, archive guard, organization filter, UUID v7, schema placement.
3. **Local end-to-end flows,** with Playwright against the running app: sign-in for each role, projects, tasks through review, timesheets through approval, deliverables through client approval, comments, files, notifications, and the client portal.
4. Build, type-check and lint.

A change is done only when all four pass locally.

---

## 10. Rough effort

Single developer, including tests. **These are estimates for planning only.**

| Change | Estimate |
|---|---|
| 1. API v1 + responses | 3–4 days |
| 2. Backend-only access | 6–8 days |
| 3. Archive | 3–4 days |
| 4. `organization_id` | 2–3 days |
| 5. UUID v7 | 1–2 days |
| 6. Dedicated schema + logins (after the spike) | 4–6 days |
| **Total** | **≈ 4–5 weeks** |

## 11. What stays the same

- **Features and screens:** no user-facing change apart from the API paths.
- **Database rules:** all business rules, row-level security policies and the seven rule triggers are kept (D4).
- **Shared design system:** unchanged.
- **Hosted databases:** not touched until a later, separately approved cutover.
