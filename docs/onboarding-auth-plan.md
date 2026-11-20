# Onboarding, authentication and multi-portal access: gap analysis and plan

| | |
|---|---|
| **Date** | 2026-11-19 |
| **Requirement** | Grow Spark PDF (Modules & Features) plus the onboarding brief (Zoho Projects–style registration, workspace, invitations, portals, security, tests) |
| **Method** | Code, migrations and the local database inspected; security points tested as real users on local Docker Supabase |
| **Decisions (2026-11-20)** | **One company per installation** (Option A, §4.1) and **three role-scoped portals** (§4.2) |
| **Status** | Phases 1–5 implemented and verified locally; see §0 |

## 0. Progress (2026-11-20)

All verified on local Docker Supabase with a production build. Nothing applied to any hosted database.

| Phase | What was built | Verified by |
|---|---|---|
| 1. Role escalation (§4.3) | Database triggers on `user_roles` and `roles`; the invitation API, acceptance and sign-up approval apply the same rule (`lib/role-guard.ts`); the role APIs show the database's reason as a 403 | 10 database checks (all fail without the fix) + 6 API checks (`ESC-*`) |
| 2. Registration and workspace | `/signup` company registration: company, workspace name and URL, your name, business email, password rule, phone, terms. Creates the workspace and the manager (superadmin), signs in and opens `/manager` directly. Closed after the first company, and Supabase self-sign-up is off. The old setup-token wizard redirects here. Workspace URL `/<slug>` opens the workspace. **Hardened after the signup bug report (§8):** one shared registration state, finishing step in one transaction, abandoned-claim recovery, session confirmed before leaving `/signup`, clear messages for every state. | `npm run e2e:local:registration`: 37 checks. `npm run e2e:local:onboarding`: 57 browser checks for tests A–G (§8.5). 6 database checks `REG-finish-*`, 8 unit checks |
| 3. Onboarding checklist | Seven skippable steps on the Manager dashboard, done from real data, hide/reopen; owner only | Same run (`OB-*`), plus a screenshot |
| 4. Invitations | Projects at invite time (joined on acceptance), phone, revoke tracking; project managers can invite into their own projects; shared password rule on acceptance | 17 API checks (`INV-*`): other manager's project 403, weak password 400, reuse/revoked/expired 410, bad token 404 |
| 5. Account management | Suspend with a reason and an optional end date (auto-lifted), recorded in the audit log | 7 API checks (`SUS-*`) |

**Still open from this plan:**
- Changing a user's role or projects directly from the Users list. Today this is done in Roles & permissions and on the project's team.
- App-level sign-in throttling: sign-in goes straight to Supabase Auth, whose built-in per-IP limits apply (`[auth.rate_limit]` in `supabase/config.toml`, and the hosted project's Auth settings). nginx `limit_req` covers the app's own API in deployment.
- Email verification for the registering manager: switch on `enable_confirmations` per environment if wanted. Invitation links already prove ownership of the invited email.
- Terms and Privacy text: the pages read `NEXT_PUBLIC_TERMS_URL` / `NEXT_PUBLIC_PRIVACY_URL`; the text itself must come from you.

---

## 1. Current implementation status

| Area | Status |
|---|---|
| Common login (one Supabase Auth for all portals) | Done and tested end to end |
| Role-based landing (manager → `/manager`, employee → `/dashboard`, client → `/client-portal`) | Done and tested (detour via `/welcome` fixed) |
| Company setup | **Different model.** First-run `/onboarding` needs a one-time setup token printed in the server terminal; it creates one superadmin. There is one company per installation (`app_settings` is a single row). No company name, workspace, slug, phone or terms at registration. |
| Public sign-up (`/signup`) | **Wrong for the brief.** Anyone can create an account; they land on `/welcome` until an admin assigns a role. The brief says employees join only by invitation. |
| Employee invitations | Done and tested: role, department, 7-day expiry, 64-hex-character token, WhatsApp link, email optional, accept + set password, resend, revoke, statuses pending/accepted/expired/revoked |
| Client invitations | Done and tested: per client account, accept + set password, statuses pending/accepted/expired/cancelled |
| Manager dashboard (PDF 2A) | Done and tested (figures checked) |
| Employee portal (PDF 3, incl. task workflow, collaboration, time) | Done and tested |
| Client portal (PDF 4) | Done and tested; isolation from other accounts and internal data verified |
| Role-based access in the database (RLS + triggers) | Done for projects, tasks, timesheets, deliverables, files, updates, budgets; **role assignment is not protected (§4.3)** |
| Deactivation | Done and tested (sign-in ban + existing sessions refused) |
| Organization isolation | **Not applicable today**: there is only one organization per installation; no `organization_id` anywhere |

## 2. What already works (must not break)

Covered by `npm run test:db` (191 checks), `npm run e2e:local` (268) and `npm run e2e:local:browser` (53):

- Invitation create → WhatsApp link → accept → set password → first sign-in, for employees and clients.
- Expired and already-used invitations are refused (status check + expiry check on accept).
- Task workflow To Do → In Progress → On Hold → Ready for Review → Changes Requested → Done, with self-approval blocked in the database.
- Timesheet submit → reject → resubmit → approve; locked weeks.
- Deliverable submit → share → client reject/approve with comments; history; notifications.
- Client sees only shared projects of its own account; no staff emails; no direct table access.
- Employees blocked from manager pages and APIs; clients blocked from internal pages and APIs.

## 3. What is missing

| # | Requirement (brief phase) | Gap |
|---|---|---|
| M1 | Company/Manager registration page (1) | No public registration with company, workspace, slug, business email, password rules, phone, terms. |
| M2 | Workspace creation (2) | No organization/workspace record, slug, or per-organization settings. |
| M3 | Auto-login to the Manager dashboard after registration (3) | Today the superadmin is created, then must log in separately. |
| M4 | Onboarding checklist inside the Manager dashboard (3) | Only a tooltip tutorial exists. Need: company profile, workspace settings, departments, invite employees, invite clients, first project, assign team; each skippable. |
| M5 | Employees cannot self-register (5) | `/signup` is open. Must become company registration only; employees and clients join by invitation. |
| M6 | Invite: assign projects at invitation time (5) | Not supported (role and department only). |
| M7 | Invitation bound to its recipient (5) | Accept uses the invited email (good), but phone-only invitations and "accept while signed in as someone else" are not handled. |
| M8 | Role escalation prevention (5, 10, 13) | **Critical, §4.3.** |
| M9 | Suspend users (12) | Only activate/deactivate. Suspend = temporary deactivation with a reason and an optional end date. |
| M10 | Change role / assign projects from the user list (12) | Role change exists in the roles screen, not in the user list. |
| M11 | Password rules, brute-force protection (13) | Supabase default (6 characters) on sign-up; accept requires 8. App rate limits only work with Upstash; otherwise they are off (nginx `limit_req` covers deployments behind nginx). Supabase Auth's own sign-in rate limit applies. |
| M12 | Email verification "where required" (13) | Off (`enable_confirmations = false`). Can be switched on per environment. |
| M13 | Organization isolation tests (14) | Need a second organization to test against (depends on §4.1). |
| M14 | Per-role portals (11) | The PDF defines **three** portals. The brief's example lists seven. Plan: keep three portals, with role-scoped content (§4.2). |

## 4. Architectural problems

### 4.1 Tenancy model (decision needed)

The app is **single-company**: one `app_settings` row, no `organization_id`, every security rule written for one company. A Zoho-style platform where **many companies register their own workspaces on one installation** needs:

- an `organizations` table (name, slug, settings) and `organization_id` on about 45 business tables;
- every row-level-security policy and SECURITY DEFINER function (about 200) to check the caller's organization;
- every server query that uses the service role (it bypasses RLS) to filter by organization, which today is hundreds of queries, so this goes together with moving all database access behind the API (migration plan step 2);
- a second organization in every isolation test.

That is the `organization_id` change of [architecture-migration-plan.md](architecture-migration-plan.md), roughly 2–3 weeks on its own.

The GSC platform rules point the other way for now: Sales & CRM, Project Management and People & HR share **one** organization (`GSC_ORGANIZATION_ID`).

| Option | What registration does | Isolation | Effort |
|---|---|---|---|
| **A. One company per installation (recommended now)** | The first registration creates the company workspace and its manager. Later visitors to the registration page are told to ask their manager for an invitation. | Between clients, employees and projects (already enforced). `organization_id` added later with the GSC migration. | About 1 week for everything in §3 |
| B. Many companies per installation (SaaS) | Every registration creates a new isolated workspace with its own slug. | Between organizations as well, in every table, policy and query. | About 3–4 weeks, and it changes the architecture you have not approved yet |

Option A builds the same screens and flows as B, so moving to B later reuses them.

### 4.2 Portals

The PDF defines three portals (Manager, Employee, Client) with role-based access. Planned mapping:

| Role | Portal | Scope |
|---|---|---|
| Superadmin | Manager portal + Administration | Everything, including platform settings |
| Executive | Manager portal | Organization-wide, read-mostly |
| Project Director | Manager portal | Projects and teams in their scope |
| Project Manager | Manager portal | Their projects |
| Team Lead | Manager portal | Their team's tasks, timesheets and workload |
| Employee | Employee portal | Their projects and tasks |
| Client | Client portal | Shared projects of their account |

Each portal is protected on the server (layout guard + API audience check + RLS), not only by hidden links.

### 4.3 Role escalation (critical, found during this analysis)

Tested on local Docker Supabase, signed in as the Executive test user:

- **A user with `manage_user_roles` (Executive, Project Director) can give anyone any role, including themselves and including Superadmin,** by inserting into `user_roles` directly (`user_roles_insert` only checks the permission). The invitation API also accepts any role, so the same users can invite a Superadmin.
- **A user with `manage_departments` can edit the permissions of any role, including their own** (`roles_update`).

Fix (database + API, applies to every path):

1. Only superadmins assign or remove **system roles** (Superadmin, Client, No Assigned Role).
2. Nobody except a superadmin changes **their own** role assignments.
3. A non-superadmin can only assign a role whose permissions are a **subset of their own** (no handing out more power than you have).
4. Only superadmins edit system roles; others can't grant a role permissions they don't hold, nor edit their own role.
5. The invitation API applies the same rules to the role being invited.

### 4.4 Browser database access

As reported earlier, older screens still read and write Supabase directly from the browser (25 files write). Row-level security protects them, but they skip API validation and break the GSC "browser → API → database" rule. Registration, onboarding and invitation screens in this plan will all go through the API.

## 5. Database changes required

| Change | Option A | Option B |
|---|---|---|
| Role-escalation triggers on `user_roles` and `roles` (§4.3) | Yes | Yes |
| `app_settings`: workspace name, slug (unique), phone, terms accepted (version, time, user), onboarding checklist state | Yes | Moves to `organizations` |
| `user_invitations`: `project_ids uuid[]`, `phone`, `revoked_at`, `revoked_by` | Yes | Yes, plus `organization_id` |
| `user_profiles`: `suspended_until`, `suspension_reason` | Yes | Yes |
| `organizations` table + `organization_id` on all business tables + RLS rewrite | No (later, GSC migration) | Yes |

All as new migrations; nothing applied to any hosted database.

## 6. Implementation plan (Option A), each step verified before the next

1. **Role-escalation fix** (§4.3): migration + API + DB tests + E2E checks.
2. **Registration and workspace creation:** `POST /api/register` creates the company workspace, the manager (superadmin) and the default settings in one step, signs them in and lands on `/manager`. The page has validation messages for every field, slug availability, duplicate email, password rules (8+ with letters and digits), phone and terms. It replaces the terminal setup token. After the first company exists, `/signup` shows "ask your manager for an invitation", and the Supabase sign-up endpoint is turned off for self-registration.
3. **Onboarding checklist** in the Manager dashboard: seven skippable steps whose done state comes from real data (for example "invite employees" is done when an invitation exists).
4. **Invitations:** assign projects at invite (added to the team on acceptance), phone on the invitation, revoke tracking, and refusal when a different user is signed in.
5. **Account management:** suspend with a reason and an optional end date, change role and assign projects from the user list, invitation status list with resend and revoke.
6. **Security hardening:** password rule shared by registration, invitations and reset; app-level sign-in throttling that works without Upstash; email confirmation as a per-environment setting.
7. **Docs and the checklist.**

## 7. Testing plan

Added to `tests/db` (database) and `tests/local-e2e` (API flows and browser), run against local Docker Supabase:

| Brief test | Checks |
|---|---|
| 1. Manager registration | Validation for each field, unique slug, duplicate email, terms; workspace and manager created; signed in; lands on `/manager`; second registration refused |
| 2. Employee invitation | Invite with role, department and projects; accept; sign in; lands on `/dashboard`; on those projects; role correct |
| 3. Employee task workflow | Already covered; adds create + self-assign + log time + comment in one run |
| 4. Client invitation | Already covered; adds "sees only assigned projects" for a newly invited client |
| 5. Client deliverable workflow | Already covered |
| 6. Security | Portal guards by URL (browser); unauthorized API calls return 401/403; reused and expired invitations refused; **role escalation refused (self-grant, Superadmin by invite, permission ceiling)**; suspended user refused |

## 8. Signup bug (2026-11-20): root cause, fix and recovery

### 8.1 What was reported

1. After submitting the company signup form, the app ended on Login instead of signing in automatically.
2. Logging in with the credentials just entered gave "Invalid email or password".
3. `/signup` then said "Grow Spark is already set up. Employees and clients join by invitation…".

### 8.2 Root cause (from the local database, Auth and API-gateway logs)

**Environment (what the reporter actually hit).** The automated registration test (`npm run e2e:local:registration`) ran `supabase db reset --local` three times (03:27, 03:37 and 03:48 UTC) on the same local database the app on port 3100 was using while it was being tried by hand. Each run wiped every account and then registered a test manager under the real company name ("Grow Spark Technologies", workspace "Grow Spark", URL `growspark`).
- Gateway log: the reporter's Chrome made 9 password sign-ins between 03:42 and 04:14. All got `400 invalid_credentials`, and it never created an account. The only manager in the database was the test account `owner.…@example.com`.
- So "Invalid email or password" was correct (that account did not exist), and "Grow Spark is already set up" referred to the test's workspace, which carried the real company name.
- The logs from before 03:25 were erased by the resets, so the first form submission itself can't be replayed. The code defects below explain every symptom on their own.

**Code defects found and fixed:**

| # | Defect | Effect |
|---|---|---|
| 1 | Two different first-run rules. `/` and `/login` used `check-first-run` ("no users", and **on any error: first run**). `/signup` used `/api/register` ("not registered and no users", fail closed). | During a database restart (seen at 03:47:24 and 03:47:27, HTTP 503), `/login` sent visitors to `/signup`, which said "already set up". The "Go to login" button then led back into the same loop. |
| 2 | The signup page showed "already set up" for any failure to load its status (503, network). | A server problem looked like someone else owning the workspace. |
| 3 | A refused submission (`409 REGISTRATION_CLOSED`) replaced the form with the "already set up" card and dropped the error. | Nothing said that no account had been created. |
| 4 | After sign-in, two navigations raced: the form's `window.location.href = '/manager'` and the signup page's own redirect to `/`, triggered by the sign-in event. | Depending on timing, the user could pass through `/` (and its first-run check) instead of going straight to `/manager`. |
| 5 | The form redirected to `/manager` without checking that the server could see the new session. | If the cookie was missing, `/manager`'s server guard sent the user to `/login`. |
| 6 | Not atomic. Profile, role and `registered_by` were three separate writes, and the last one was unchecked. Clean-up errors were ignored. A claim left by a crash locked the installation forever. | A half-finished registration was possible, and nobody could ever register again. |
| 7 | An installation that has users but was never registered (for example after the E2E seed) showed "This workspace is already set up". | A misleading message, with no hint of what to do. |
| 8 | The login form's 1.5 s fallback redirect still fired after the page had already opened the portal. | A second navigation to `/` interrupted the page the user had just opened. The browser test saw this once as `ERR_ABORTED`. |
| 9 | The registration test reset any local database and used the real company name. | It destroyed a developer's own local workspace without asking. |

### 8.3 What changed

| Area | Change | Files |
|---|---|---|
| One rule for "can a company register here?" | `getRegistrationState()`: `new` / `abandoned` (open), `registered` / `in_progress` / `has_users` / `incomplete` (closed), each with its own message. Used by `GET`/`POST /api/register`, `check-first-run` and the legacy setup-token route. All fail **closed** with 503. | `lib/registration-state.ts` (new), `app/api/register/route.ts`, `app/api/onboarding/check-first-run/route.ts`, `lib/onboarding/setup-token.ts` |
| Atomic registration | Stage 1: claim (compare-and-swap; an abandoned claim more than 2 minutes old, with no manager and no users, can be taken over). Stage 2: create the sign-in account. Stage 3: `complete_workspace_registration()` writes profile + Superadmin role + `registered_by` in one transaction (service role only). A failure in stage 2 or 3 deletes the account and releases the claim. Clean-up errors are reported (`REGISTRATION_INCOMPLETE`), and the end state is verified before `201`. | `supabase/migrations/20261122000900_complete_workspace_registration.sql` (new), `app/api/register/route.ts` |
| Auto-login without races | The form owns the journey: create → `signInWithPassword` (the same Supabase sign-in as the login page) → `GET /api/profile` must return the new manager (the server sees the cookie) → `location.replace('/manager')`. The signup page's "already signed in" redirect is switched off once the form starts signing in, and it sends signed-in visitors to their portal, not `/`. If sign-in fails after the workspace was created, the page says so and offers "Log in" with the email filled in. | `components/registration-form.tsx`, `app/signup/page.tsx`, `components/login-form.tsx` |
| Real messages | "Can't check this installation right now" plus Try again (503/network); a separate message for each closed reason; "Your details were not saved and no account was created" on a refused submission; field errors from the server; "This account is suspended or deactivated" instead of "User is banned". | `components/registration-form.tsx`, `components/login-form.tsx` |
| Login redirect race | The fallback redirect runs only if the page is still where the sign-in happened. | `components/login-form.tsx` |
| Test safety | Local resets refuse when the database has any account that isn't `@example.com` (or a workspace registered by one), unless `--wipe-local-accounts` is passed. The tests register "E2E Test Company" / "E2E Workspace" / `e2e-workspace`, never a real name. | `tests/local-e2e/lib.mjs` (`resetLocalDb`), `registration.mjs`, `onboarding-browser.mjs`, `fresh.mjs` |

No second authentication system, no new tables, and no change to roles or permissions. Nothing was applied to a hosted database.

### 8.4 The flow now

```
Visitor opens /  -- check-first-run (same rule as /signup) --> brand-new installation? -- yes --> /signup
                                                                                     \- no  --> login form

/signup   GET /api/register
  |- 503 / network error --> "Can't check this installation right now" [Try again] [Go to login]
  |- closed --> message for the reason (registered: "<Workspace> is already set up" | in progress | has users | incomplete)
  \- open   --> form (validated in the browser; a double submit is ignored)
        POST /api/register
          1 claim app_settings (compare-and-swap)                       409 if someone else got there first
          2 Supabase Auth admin API: create the account (email confirmed)
          3 complete_workspace_registration(): profile superadmin + Superadmin role + registered_by, one transaction
            failure in 2 or 3 --> delete the account, release the claim --> error shown, nothing left behind
          --> 201 { landing: '/manager' }
        signInWithPassword in the browser (session cookie sb-project-management-auth)
        GET /api/profile must return the new manager (the server sees the session)
        location.replace('/manager')          <-- the only navigation
          otherwise --> "Your workspace is ready ... Log in" (/login?email=...)

/manager  server guard: session cookie -> user -> profile -> manager? --> Manager dashboard with the setup checklist
Employees: /invite/<token> -> set password -> log in -> /dashboard            (manager portal refused)
Clients:   /client-invite/<token> -> name + password -> log in -> /client-portal (only their account's shared projects)
```

### 8.5 Tests

| Brief test | Where | Result (local Docker, production build) |
|---|---|---|
| A. Fresh install | `npm run e2e:local:onboarding`, section A | Pass: `/ → /signup → /manager` (no `/login`), one POST for a double click, session cookie, dashboard + checklist, workspace linked to the manager, Superadmin role, email confirmed, exactly 1 account and 1 profile |
| B. Login after registration | section B | Pass: sign out → `/login`; `/manager` needs login; wrong password shows "Invalid email or password"; correct login → `/manager`; reload keeps the session |
| C. Session persistence | section C | Pass: reload, `/manager/team`, `/manager/approvals`, `/projects`, `/admin/settings`, a second tab, `/login` and `/signup` while signed in → `/manager`; an API call from the page sees the session |
| D. Duplicate company | both D sections | Pass: in progress → 409; abandoned claim → open again; 4 simultaneous registrations → exactly one 201, three 409, 1 account; after setup `/signup` names the workspace with no form; a second company, and the same manager again, → 409 with no account created; `/` shows the login form (no loop) |
| E. Employee invitation | section E | Pass: invitation with a project and WhatsApp link; accepted in the browser; login → `/dashboard`; `/manager` refused by the server; `/client-portal` → `/dashboard`; on the invited project; manager API 403; invitation marked accepted |
| F. Client invitation | section F | Pass: accepted in the browser; login → `/client-portal`; sees only the shared project of their account (not the internal one, not another client's); `/manager` and `/dashboard` → `/client-portal`; internal project API refused |
| G. Security | section G | Pass: visitor `/manager` → `/login`; API 401; Supabase self-sign-up 422; forged session cookie → `/login`; employee can't grant themselves Superadmin or set `is_superadmin` (42501); suspended account refused with a clear message; registration closed |
| Database | `npm run test:db` (`REG-finish-*`) | Pass: server-only, all-or-nothing, needs a claim, works with a claim, only once, refuses when other users exist |
| Unit | `__tests__/unit/registration-state.test.ts` | Pass: every state and message |

Observation, not changed: new projects are shared with the client by default (`projects.shared_with_client` defaults to `true`, migration `20261118000000`). A client therefore sees every project on their account unless sharing is switched off on the project.

### 8.6 Recovery

**Local (Docker).**
- To start again and register your own company: `npm run local:fresh -- --reset-local-db`, then open `http://localhost:3100` (you are sent to `/signup`).
- It refuses if the database holds accounts that aren't `@example.com` test accounts (for example a workspace you registered), unless you add `--wipe-local-accounts`.
- `npm run e2e:local`, `e2e:local:browser` and `e2e:local:seed` add the `@example.com` test users to whatever is there. They never reset the database.
- `npm run e2e:local:registration` and `npm run e2e:local:onboarding` reset it, with the same protection.
- Once users exist, registration is closed: an installation with users can't be claimed.

**A stuck registration on any environment** (read-only diagnosis first):

```sql
select registered_at, registered_by, workspace_name from public.app_settings where id = true;
select count(*) from public.user_profiles;
```

- `registered_at` set, `registered_by` empty, **no users**: nothing to do. After 2 minutes the claim counts as abandoned and `/signup` opens again.
- `registered_at` set, `registered_by` empty, **users exist** (`/signup` says "Workspace setup did not finish"): find the account created at `registered_at`.
  - If it is the intended manager, finish with `select public.complete_workspace_registration('<user id>', '<email>', '<name>', '<phone or null>');` as the service role.
  - Otherwise remove that account, then clear the claim (`update public.app_settings set registered_at = null, workspace_slug = null where id = true and registered_by is null;`).
  - On a hosted database, only with explicit authorization.
