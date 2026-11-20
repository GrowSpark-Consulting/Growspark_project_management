# Project Management

The **Project Management** app of the Grow Spark (GSC) platform. It is one of three apps built separately and integrated later:

| App | Local web port |
|---|---|
| Sales & CRM | 3000 |
| **Project Management (this repository)** | **3100** |
| People & HR | 3200 |

The app has three portals, all running on one shared project and task engine:

| Portal | Who | Main screens |
|---|---|---|
| **Manager** (`/manager`) | Superadmins, and users with `manage_projects`, `manage_all_projects` or `approve_timesheets` | Overview (KPIs, delayed projects, workload), team and workload, timesheet approval, approvals queue, reports with CSV export, project templates |
| **Employee** (`/dashboard`) | Every internal user | My work summary, My Tasks, calendar, timesheets, my performance, notifications |
| **Client** (`/client-portal`) | Client users of an account | Shared projects, timeline, deliverables to approve, documents, discussion, issues, feedback, approvals, notifications |

After sign-in, users land on their portal automatically ([lib/portal.ts](lib/portal.ts)).

---

## Features

- **Projects:**
  - Accounts and projects with a Project Manager, team, dates, status and priority.
  - Progress, milestones, deliverables, documents, risks, budget (managers only), archive, and templates.
- **Tasks:**
  - Six statuses: To Do, In Progress, On Hold, Ready for Review, Changes Requested, Done.
  - Start, pause and resume with an optional timer, and submit for review. Only the reviewer or a project manager can approve or request changes.
  - Subtasks (one level), dependencies (cycles blocked), full task history, and comments with replies, @mentions and attachments.
  - Kanban, Gantt and list views.
- **Time:**
  - Clock in and out, manual time entries, and weekly timesheets.
  - Submitting a timesheet locks the week; approvers approve or reject it.
- **Workflows:**
  - Visual workflow builder with role and approval steps and history.
  - Approval steps marked **Client approval** can be decided from the client portal.
- **Collaboration and notifications:**
  - Project updates (internal, or shared with the client by a manager) and an in-app notification bell.
  - Daily deadline reminders run as a cron job.
- **Administration:**
  - Users (activate or deactivate), roles and permissions, departments, and company settings.
  - Invitations by email or by a free WhatsApp share link.

The feature-by-feature status, including what is tested and what isn't yet, is in [IMPLEMENTATION_CHECKLIST.md](IMPLEMENTATION_CHECKLIST.md).

---

## Architecture

| Layer | Technology |
|---|---|
| Web app | Next.js 15 (App Router), React 19, TypeScript |
| UI | Tailwind CSS v4 and shadcn/ui, themed with the **Grow Spark Workspace** design system: light and dark themes, Inter and JetBrains Mono, Lucide icons |
| API | Next.js route handlers in [app/api](app/api), mostly wrapped by `api()` in [lib/api/context.ts](lib/api/context.ts) for authentication, the active-user check, the client/internal split, project access checks and error mapping |
| Database | Supabase Postgres 17, with row-level security (RLS) on every table and business rules enforced in triggers |
| Auth and files | Supabase Auth (email and password, invitations); Supabase Storage (private `project-files` bucket, 10 MB per file, downloads by 60-second signed links) |

### How data is accessed

- **Internal API routes** read and write with the signed-in user's Supabase session, so RLS and the database triggers apply to every request.
  - Some routes use the server's service-role key, but only after their own permission checks.
- **Client portal routes** (`/api/client/portal/*`) never let clients read tables directly. The server checks the client's account and the project's `shared_with_client` flag, then returns only whitelisted fields.
- **Budgets** live in the manager-only table `project_financials` and are always read through the caller's session ([lib/project-financials.ts](lib/project-financials.ts)).

### Rules enforced by the database

The database enforces these rules itself, so they still hold if someone bypasses the API:

| Rule | Where |
|---|---|
| Users can't change their own client, account, superadmin or active status | `protect_profile_privileged_columns` |
| Task status flow: the assignee can't approve their own task | `enforce_task_status_transition` |
| Task fields: only the creator or a manager edits details or reassigns; only a manager picks the reviewer; the reviewer is never the assignee; assignees must be team members | `enforce_task_field_rules` |
| Dependencies stay within one project and can't form a cycle of any length | `validate_task_dependency` |
| Timesheets: the owner can only submit; only an approver decides; submitted weeks are locked | `enforce_timesheet_rules`, `enforce_timesheet_lock` |
| Only project managers decide what the client sees | `enforce_client_visibility`, `enforce_deliverable_rules`, `enforce_project_file_rules` |
| A project completes when its workflow completes | `complete_project_when_workflow_completes` |

### Design system

- **Source:** the shared tokens live in [design/gs-tokens.json](design/gs-tokens.json). `npm run design:tokens` regenerates [app/gs-tokens.css](app/gs-tokens.css) from them.
- **Theme mapping:** [app/globals.css](app/globals.css) maps shadcn/ui and the Tailwind palette onto the tokens, so every screen follows the theme.
- **Theme choice:** users pick Light, Dark or System in the user menu.
- **New code** should use the token utilities (`bg-surface`, `text-ink`, `bg-success-soft`, …) and the shared components (`StatCard`, `StatusBadge`, `Badge`, `Table`, `Tabs`).

### Known gaps against the GSC platform rules

The app is still being aligned with the shared platform rules:
- It uses one schema (`public`), not a dedicated `project` schema.
- Browsers can query Supabase directly, with RLS as the guard.
- There is no `organization_id` column.
- IDs are UUID v4, generated by the database.
- Some records are hard-deleted rather than archived.
- Routes live under `/api`, not `/api/v1`.

These changes are planned in [docs/architecture-migration-plan.md](docs/architecture-migration-plan.md) and will be made only after that plan is reviewed and approved.

---

## Local development (Docker)

Everything runs locally. **Never point a development machine at a hosted or production database.**

### Prerequisites

- Node.js 18 or newer
- Docker Desktop, running

### First run

```bash
npm install
npx supabase start          # Postgres 17, Auth, Storage, Studio, Mailpit in Docker; applies all migrations
npx supabase status -o env  # prints the local URL and keys
```

Create `.env.development.local` from those values. It's git-ignored, and in development it takes priority over `.env.local`, so `npm run dev` always uses the local database.

```bash
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY=<anon / publishable key from status>
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<same>
SUPABASE_SERVICE_ROLE_KEY=<service role / secret key from status>
NEXT_PUBLIC_APP_URL=http://localhost:3100
```

Then start the app:

```bash
npm run dev                 # http://localhost:3100
```

- **First manager:** on a new installation the app opens `/signup`. Registering the company creates the workspace and its manager (superadmin), signs you in and opens the Manager dashboard with a setup checklist. Registration then closes. Optionally require a code with `REGISTRATION_CODE`.
- **Everyone else:** employees and clients join by invitation only (Manager › Team › Invite employee, or Administration › Invitations / Client portal). Public self-sign-up is switched off in Supabase Auth.
- **Emails:** in local development they go to Mailpit instead of real inboxes.

### Local services

| Service | URL |
|---|---|
| App | http://localhost:3100 |
| Supabase API | http://127.0.0.1:54321 |
| Postgres | localhost:54322 |
| Supabase Studio | http://localhost:54323 |
| Mailpit (local email) | http://localhost:54324 |

### Useful commands

| Command | What it does |
|---|---|
| `npm run dev` / `npm run build` / `npm start` | Develop, build or serve on port 3100 (override with `PORT=…`) |
| `npx supabase start` / `npx supabase stop` | Start or stop the local database stack (data is kept) |
| `npx supabase db reset` | Rebuild the **local** database from the migrations and seed |
| `npm run design:tokens` | Regenerate the design-token CSS after updating `design/gs-tokens.json` |

---

## Database and migrations

- Migrations live in [supabase/migrations](supabase/migrations) and are applied in filename order.
- The seven newest migrations add the three-portal platform:

| Migration | Adds |
|---|---|
| `20261118000000_security_users_sharing.sql` | Row-level security on every table; user activation; client sharing flags; role templates (Executive, Project Director, Project Manager, Team Lead, Employee); `approve_timesheets` |
| `20261118000100_project_engine.sql` | Task workflow and history, subtasks, dependencies, archive, risks, the deliverable flow, timesheets, project templates |
| `20261118000200_collaboration.sql` | Comments (replies and mentions), project files and the storage bucket, the task timer |
| `20261119000000_database_rule_fixes.sql` | The database-level rules above, `project_financials`, and the workflow-completion fix |
| `20261120000000_money_decimal_currency.sql` | Money as Decimal(14,2) with an ISO currency (default INR) |
| `20261121000000_auth_user_profile_trigger.sql` | A `user_profiles` row for every new sign-in account (the trigger was missing on fresh databases) |
| `20261121000100_workflow_instance_select_policy.sql` | Project managers and team members can start workflows |

**Migration rules:**
- Never edit a migration that has been applied to a shared or hosted database. Fix forward with a new migration.
- Shared or hosted databases are migrated only on purpose, after a backup, never as a side effect of development.
- Record every schema change in [docs/schema-changelog.md](docs/schema-changelog.md) and every published event in [docs/events.md](docs/events.md).

---

## Testing

| Command | What it covers |
|---|---|
| `npm run test:db` | Database tests on an in-memory Postgres (no Docker needed): migrations from a clean database, row-level security and triggers as real users, code-vs-schema drift, UI-to-API wiring. See [tests/db/README.md](tests/db/README.md). |
| `npm run e2e:local` | End-to-end API flows as 9 real test users against the running app and local Docker Supabase (seeds its own data). See [tests/local-e2e/README.md](tests/local-e2e/README.md). |
| `npm run e2e:local:registration` | **Resets the local database**, then tests company registration on a brand-new installation (browser + API) and re-creates the test users |
| `npm run e2e:local:onboarding` | **Resets the local database.** The full onboarding journey in a real browser: register → `/manager`, logout/login, session persistence, duplicate and simultaneous registrations, employee and client invitations, security checks |
| `npm run local:fresh -- --reset-local-db` | Empties the local database so you can register your own company at `/signup`. Like the other reset commands, it refuses if the database holds accounts that aren't `@example.com` test accounts (add `--wipe-local-accounts` to override) |
| `npm run e2e:local:browser` | Browser pass: login as each role, landing page and role guards, every main screen (screenshots in `tests/local-e2e/output/`) |
| `npm run e2e:local:build` / `npm run e2e:local:start` | Production build and server using the **local** Supabase settings, for testing in production mode without touching hosted keys. Rebuild normally before deploying. |
| `npm test` | Unit tests (Vitest) |
| `npm run test:playwright` | Browser tests (Playwright) against the local app on port 3100 |
| `npx tsc --noEmit` and `npm run build` | Type-check and production build |

The local end-to-end commands refuse to run unless `.env.development.local` points at `localhost` / `127.0.0.1`.

Results and open findings are recorded in [FULLAUDIT.md](FULLAUDIT.md).

---

## Project structure

```
app/
  (manager)/manager/      Manager portal
  (client-portal)/        Client portal
  dashboard/ tasks/ calendar/ timesheets/ performance/ notifications/   Employee portal
  projects/ accounts/ admin/ ...                                        Shared and admin screens
  api/                    Route handlers (internal, manager, me, client/portal, cron)
components/
  ui/                     Base components themed with the design system (Button, Card, Badge, StatCard, Table, Tabs, ...)
  sidebar/ top-header.tsx app-layout.tsx  App shell
  task/ project/ client/ manager/         Feature components
lib/
  api/context.ts          API wrapper, access checks, error mapping
  portal.ts               Portal routing and role helpers
  task-rules.ts           Task statuses, actions and badge tones
  notify.ts files.ts comments.ts project-financials.ts theme.ts ...
design/gs-tokens.json     Grow Spark Workspace design tokens (shared with the other two apps)
supabase/                 config.toml (Postgres 17, ports), migrations, seed
tests/db/                 Local database test suites
tests/local-e2e/          End-to-end API flows and browser pass against local Docker Supabase
e2e/                      Playwright tests
nginx/                    Reverse-proxy config for deployment (app on 3100, rate limits, TLS notes)
docs/                     Schema changelog, event list
```

---

## Deployment notes

- **Proxy:** [nginx/project_management.conf](nginx/project_management.conf) proxies the app on port 3100, rate-limits auth and API routes, and allows 12 MB uploads.
  - Enable HTTPS with certbot once a domain points at the server.
  - Supabase Studio and the mail catcher are not exposed; reach them through an SSH tunnel.
- **Deadline reminders:** set `CRON_SECRET` and schedule a daily call:

  ```
  0 8 * * * curl -s -X POST -H "Authorization: Bearer $CRON_SECRET" https://<host>/api/cron/deadline-reminders
  ```

- **Client approvals:** in the workflow editor, tick **Client approval** on every approval step that clients should decide.

---

## Documentation

| Document | Contents |
|---|---|
| [IMPLEMENTATION_CHECKLIST.md](IMPLEMENTATION_CHECKLIST.md) | Every requirement: built or not, tested or not |
| [FULLAUDIT.md](FULLAUDIT.md) | Audit results, open findings, test register |
| [PROJECT_MANAGEMENT_ARCHITECTURE.md](PROJECT_MANAGEMENT_ARCHITECTURE.md) | Three-portal architecture |
| [PROJECT_MANAGEMENT_FEATURE_MATRIX.md](PROJECT_MANAGEMENT_FEATURE_MATRIX.md) | Requirements matrix |
| [PROJECT_MANAGEMENT_DATABASE_PLAN.md](PROJECT_MANAGEMENT_DATABASE_PLAN.md) | Database design |
| [PROJECT_MANAGEMENT_API_PLAN.md](PROJECT_MANAGEMENT_API_PLAN.md) | API design |
| [PROJECT_MANAGEMENT_DEVELOPMENT_ROADMAP.md](PROJECT_MANAGEMENT_DEVELOPMENT_ROADMAP.md) | Phases and roadmap |
| [PROJECT_MANAGEMENT_TEST_PLAN.md](PROJECT_MANAGEMENT_TEST_PLAN.md) | Test cases and personas |
| [tests/db/README.md](tests/db/README.md) | Running the database tests |
