# Schema changelog: Project Management

A short record of every database change, so the Sales & CRM and People & HR teams can see what changed. Newest first. GSC platform rule §5.7.

| | |
|---|---|
| **Schema** | `public` today. A dedicated `project` schema is planned and pending review. |
| **How changes ship** | One SQL migration per change in `supabase/migrations/`. Never edit a migration that has been applied to a shared or hosted database; fix forward. |
| **Where applied** | Local development databases only. **None of the 2026-11 migrations have been applied to any hosted database.** |

---

## 2026-11-21: Project managers can start workflows

Migration: `20261121000100_workflow_instance_select_policy.sql`

- **Replaced policy `workflow_instances_select`.** It now checks the row's own `project_id` / `task_id` through the new helper `user_can_view_workflow_row(project_id, task_id)`, instead of looking the instance up by id. The old lookup could not see a row being inserted, so `insert … returning` (used by `POST /api/workflows/start`) failed for everyone without an org-wide workflow permission.
- **Compatibility:** the rules are the same as before (superadmin, `view_all_workflows`, `execute_any_workflow`, `manage_all_workflows`, team member, project creator or manager, task assignee), so who can see existing instances is unchanged.

## 2026-11-21: User profile created on sign-up

Migration: `20261121000000_auth_user_profile_trigger.sql`

- **New trigger `on_auth_user_created`** on `auth.users` (after insert) calls `public.handle_new_user()`, which creates the matching `user_profiles` row. The baseline defined the function but never attached it, so on a fresh database new users had no profile and failed every permission check.
- **Changed function:** `handle_new_user()` is now idempotent (`ON CONFLICT (id) DO NOTHING`).
- **Backfill:** creates the missing profile for any existing auth user that has an email but no profile.
- **Compatibility:** the trigger is only created when no trigger on `auth.users` already calls `handle_new_user()`, so a database where it was added by hand is unchanged. Verified on local Supabase (Postgres 17.6).

## 2026-11-20: Money as Decimal(14,2) + currency

Migration: `20261120000000_money_decimal_currency.sql`

- `project_financials.budget` and `hourly_rate` changed from `numeric(12,2)` / `numeric(10,2)` to `numeric(14,2)`.
- New column `project_financials.currency`: `text`, not null, default `INR`, must be a 3-letter uppercase ISO code.
- `app_settings.default_hourly_rate` changed to `numeric(14,2)`.
- `app_settings.currency` now defaults to `INR` and must be a 3-letter uppercase ISO code. The untouched default row is changed from `USD` to `INR`; a currency someone chose is kept.
- **Compatibility:** precision only widens, so no data is lost. The API accepts an optional `currency` on `PATCH /api/projects/{id}`.

## 2026-11-19: Database rule fixes

Migration: `20261119000000_database_rule_fixes.sql`

- **New table `project_financials`:** `project_id` (PK, FK to `projects`), `budget`, `hourly_rate`, `updated_by`, `updated_at`. Readable by project managers and `view_all_projects` holders; writable by project managers only.
- **New columns on `projects`:**
  - `completed_at timestamptz`
  - `workflow_instance_id uuid`, a plain column with no foreign key so that joins between `projects` and `workflow_instances` stay unambiguous
- **New triggers:**
  - `enforce_task_field_rules` on `tasks`
  - `enforce_timesheet_rules` on `timesheets`
  - `enforce_client_visibility` on `project_updates` and `project_issues`
  - `enforce_deliverable_rules` on `deliverables`
  - `enforce_project_file_rules` on `project_files`
  - `complete_project_when_workflow_completes` on `workflow_instances`
- **Changed function:** `validate_task_dependency` now rejects cycles of any length.
- **Replaced policies:** three broad 2026-03 policies on `deliverables` ("Users can update/create/delete …") replaced by `dl_update_submitter` and `dl_delete_submitter`.
- **New helper functions:** `caller_is_trusted()` and `user_is_valid_task_member(project, user)`.

## 2026-11-18: Collaboration

Migration: `20261118000200_collaboration.sql`

- **New table `comments`:**
  - On a task **or** a project update.
  - One reply level (`parent_id`) and a `mentions uuid[]` column.
  - The project is derived by a trigger.
- **New table `project_files`:** documents, task attachments, client uploads and the `client_visible` flag.
- **New columns:** `deliverables.file_id` (FK to `project_files`) and `clock_sessions.task_id`.
- **Storage:** new private bucket `project-files` (10 MB per file).

## 2026-11-18: Project engine

Migration: `20261118000100_project_engine.sql`

- **`projects`:** new `archived_at` and `feedback_requested_at`.
- **`tasks` statuses:** now `todo`, `in_progress`, `on_hold`, `review`, `changes_requested`, `done`. Legacy `backlog` and `blocked` are still accepted and are migrated.
- **`tasks` columns:** new `parent_task_id`, `reviewer_id`, `review_note`, `progress_percent`, `started_at`, `completed_at`.
- **New tables:**
  - `task_activity`: append-only history, written by a trigger.
  - `timesheets`: one per user per week, with status draft, submitted, approved or rejected.
  - `project_templates`
- **`project_issues`:** new `kind` (issue or risk), `severity`, `title`, `client_visible` and `resolution_note`.
- **`deliverables`:** new status `client_review`, plus `shared_at` and `shared_by`.
- **Triggers:**
  - Task status transitions (only the reviewer or a project manager approves).
  - Subtask validation.
  - Dependency validation.
  - Timesheet week lock on `time_entries`.

## 2026-11-18: Security, users, sharing

Migration: `20261118000000_security_users_sharing.sql`

- **Row-level security:** enabled on the 13 tables that lacked it. `anon` has no table access.
- **`user_profiles`:** new `is_active`, `deactivated_at` and `phone`. Privileged columns are protected by a trigger.
- **New sharing flags:**
  - `projects.shared_with_client`
  - `project_updates.client_visible`
  - `milestones`: `project_id`, `status`, `completed_at`, `client_visible`, `created_by`, `updated_at`
- **`notifications`:** new `dedupe_key` and `project_id`.
- **New table `app_settings`:** the company account.
- **Client access:** direct client table policies removed. Clients read through the server only.
- **Roles:** templates seeded (Executive, Project Director, Project Manager, Team Lead, Employee) plus the new permission `approve_timesheets`.

## Before 2026-11-18

- The baseline schema (`20250129000000_baseline.sql`) and the 2025-12 to 2026-03 migrations in `supabase/migrations/`.
- Hosted databases match the chain up to `20260324100000_client_portal_schema_fixes.sql`, checked read-only on 2026-11-19.
