# Local end-to-end tests

These run the real app (Next.js on port 3100) against a real local Supabase in Docker (Postgres 17), signed in as real users. They complement `npm run test:db`, which checks the database rules in an in-memory Postgres.

**Local only.** Every script reads `.env.development.local` and refuses to run unless the Supabase URL is `localhost` / `127.0.0.1`. They create and change data, so never point them at a hosted database.

## Prerequisites

1. Docker Desktop running.
2. Local Supabase started from the project folder:
   ```bash
   npx supabase start        # applies every migration and supabase/seed.sql
   ```
3. `.env.development.local` with the local keys (Next.js uses it in `npm run dev` before `.env.local`):
   ```bash
   npx supabase status -o env   # copy API_URL, ANON_KEY, SERVICE_ROLE_KEY
   ```
   ```
   NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
   NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY=<ANON_KEY>
   NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<ANON_KEY>
   SUPABASE_URL=http://127.0.0.1:54321
   SUPABASE_SERVICE_ROLE_KEY=<SERVICE_ROLE_KEY>
   NEXT_PUBLIC_APP_URL=http://localhost:3100
   CRON_SECRET=local-e2e-cron-secret
   ```
4. The app running on port 3100, either:
   - `npm run dev`, or
   - **recommended for a full run:** `npm run e2e:local:build` then `npm run e2e:local:start`. This is a production build started with the values from `.env.development.local` passed as environment variables, so it never reads the hosted keys in `.env.local`. It is much faster and steadier than dev mode, which recompiles every page on first visit and restarts itself when memory runs low. Rebuild normally before deploying.

**Low on memory (8 GB machines):** the app doesn't use Supabase Studio, analytics, Realtime or edge functions, so you can start without them:

```bash
npx supabase start -x studio,logflare,vector,edge-runtime,realtime,postgres-meta
```

## Commands

| Command | What it does |
|---|---|
| `npm run e2e:local:seed` | Creates the test users and base data. Safe to re-run; resets this week's timesheets and time entries for the test users only. |
| `npm run e2e:local` | API flows (seeds first): 264 checks across projects, tasks and review, documents, timesheets, deliverables, workflows, client portal, dashboards and reports, admin, cron. |
| `npm run e2e:local:browser` | Browser pass (seeds first): logs in through the login page as superadmin, project manager, employee and client, checks the landing page and role guards, and opens every main screen. Screenshots go to `tests/local-e2e/output/` (gitignored). |

Exit code 0 means every check passed. Failures are listed at the end with the HTTP status and message.

The browser pass uses Playwright's Chromium headless shell from `%LOCALAPPDATA%\ms-playwright` (or `CHROME_PATH`). If none is installed: `npx playwright install chromium`. In dev mode the first visit to each page compiles it, so the first run takes several minutes.

## Test users (password `Test1234!`)

| Key | Email | Role | Notes |
|---|---|---|---|
| superadmin | e2e.superadmin@example.com | Superadmin | |
| executive | e2e.exec@example.com | Executive | org-wide viewer |
| pm | e2e.pm@example.com | Project Manager | manages Website Redesign and Internal Tools |
| pm2 | e2e.pm2@example.com | Project Manager | manages Globex Portal only |
| emp1 | e2e.emp1@example.com | Employee | on Website Redesign and Internal Tools |
| emp2 | e2e.emp2@example.com | Employee | on Website Redesign and Globex Portal |
| outsider | e2e.outsider@example.com | Employee | on no project |
| client | e2e.client@example.com | Client | Acme Corp: sees Website Redesign only |
| client2 | e2e.client2@example.com | Client | Globex: isolation checks |

## What the API flows cover

| Area | Examples |
|---|---|
| Access control | anonymous 401; client blocked from internal APIs; outsider and client can't read tables directly |
| Projects | budget write/read (manager, executive) and no budget for employees or other managers; create, complete, reopen, archive (hidden, read-only), unarchive; milestones; save as template and create from template |
| Tasks | create, validation, assignee must be on the team, employee can't pick a reviewer or change priority; start, pause, resume, submit, self-approval blocked, request changes (note required), resubmit, approve; direct database bypass blocked; history; notifications |
| Subtasks and dependencies | one subtask level; 3-task cycle and self-dependency rejected; delete rules |
| Comments | comment, mention, reply, reply depth, outsider blocked, mention and reply notifications |
| Time | clock in and out, time entries, submit week, locked week (409), self-approval blocked, other manager blocked, reject with note, resubmit, approve, history, notifications |
| Deliverables | draft, submit, employee can't share, database bypass blocked, share, client isolation, reject with note, resubmit (version 2), approve, approval history, notifications |
| Workflows | build a template (start → role step → end), inactive template refused, activate, project manager starts it (project link written, history rows complete), employee finishes the step, instance completes and the project is completed automatically (D-1, D-2, D-3) |
| Client portal | shared vs internal updates, client comments and discussion, issues (report, resolve, status), risks, feedback request and submission, project list isolation, no staff emails, timeline |
| Documents | task attachment, blocked file type, download (bytes match), staff-only sharing, client view and download, other account blocked, client upload with notification, deliverable file downloadable once shared, file must be in the same project |
| Screens (APIs) | employee summary (due today, hours, counts), task views and filters, calendar (tasks, project deadlines, milestones), performance; manager dashboard figures (scope, counts, delayed, workload, feedback, risks, activity), team, approvals, timesheets, all 7 reports with content checks; employee blocked from the budget report |
| Admin | settings, employee invitation with WhatsApp link, acceptance and first sign-in, client invitation with WhatsApp link, acceptance and first sign-in, deactivate (existing session and new sign-in refused), reactivate, self-deactivation blocked |
| Cron | deadline reminders need the secret |
