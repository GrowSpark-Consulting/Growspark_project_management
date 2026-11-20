# Schema changelog: Project Management

A short record of every database change, so the Sales & CRM and People & HR teams can see what changed. Newest first. GSC platform rule §5.7.

| | |
|---|---|
| **Schema** | `public` today. A dedicated `project` schema is planned and pending review. |
| **How changes ship** | One SQL migration per change in `supabase/migrations/`. Never edit a migration that has been applied to a shared or hosted database; fix forward. |
| **Where applied** | Local development databases only. **None of the 2026-11 migrations have been applied to any hosted database.** |

---

## 2026-11-22: Users who appear in the audit log can be deleted

| Migration | Change |
|---|---|
| `20261122001200_audit_log_allow_actor_unlink.sql` | `audit_log_append_only()` now allows the one update that `ON DELETE SET NULL` performs: clearing `actor_id` while every other column stays identical. The deleted person's id is kept in `details.deleted_actor_id`. Before, deleting any user who had done something audited failed ("Database error deleting user"). Any other update, and every delete, is still refused. |

**Compatibility:** changes one trigger function; no table changes. Applied to local Docker only.

## 2026-11-22: Account managers can create projects in their account

| Migration | Change |
|---|---|
| `20261122001000_project_insert_account_manager.sql` | `projects_insert` policy: a user with `manage_projects` may now also create projects in an account they **manage** (`accounts.account_manager_id`, checked with the existing `user_is_account_manager()`), not only one they are a member of. Matches the app's permission check and the `projects_select` policy. Before, a Project Director who added a client account was refused (42501) when creating its first project. |

**Compatibility:** widens one INSERT policy for account managers who already hold `manage_projects`; nothing else changes. Applied to local Docker only.

## 2026-11-22: Company registration finishes in one transaction

| Migration | Change |
|---|---|
| `20261122000900_complete_workspace_registration.sql` | Function `complete_workspace_registration(user_id, email, name, phone)`, SECURITY DEFINER, executable by `service_role` only. Within a held registration claim, writes the manager's profile (superadmin, active), the Superadmin role and `app_settings.registered_by` together or not at all. Refuses (55000) with no claim, an already finished registration, or other users present. Used by `POST /api/register`; see `docs/onboarding-auth-plan.md` §8. |

**Compatibility:** additive (one function, no table changes). Applied to local Docker only.

## 2026-11-22: Onboarding, security and planning (9 migrations)

| Migration | Change |
|---|---|
| `20261122000000_workflow_and_status_notifications.sql` | Triggers `notify_workflow_step_active` (on `workflow_active_steps`) and `notify_client_project_status` (on `projects.status`): the assignee or role holders are told when a workflow step reaches them; clients are told when a client-approval step needs them and when a shared project's status changes. |
| `20261122000100_form_templates_fields_active.sql` | `form_templates.is_active` (default true) and a read-only `fields` column derived from `schema` (D-5). |
| `20261122000200_audit_log.sql` | New table `audit_log` (append-only, superadmin-readable, server-written). Records superadmin / override access to projects and account status changes (SEC-12). |
| `20261122000300_task_dependency_start_guard.sql` | Trigger `enforce_dependencies_before_start` on `tasks`: a task can't move to In Progress while a task it depends on isn't done (project managers may override). |
| `20261122000400_project_board_columns.sql` | `projects.board_columns jsonb`: per-project names, order, visibility and WIP limits for the six status columns. |
| `20261122000500_role_escalation_guard.sql` | Triggers on `user_roles` and `roles` plus `caller_holds_permissions(jsonb)`: only superadmins assign system roles or change a superadmin's roles; nobody else changes their own roles; roles can only be assigned or edited within the caller's own permissions. |
| `20261122000600_workspace_registration.sql` | `app_settings`: `workspace_name`, `workspace_slug` (format-checked), `company_phone`, `registered_at`, `registered_by`, `terms_version`, `terms_accepted_at`, `onboarding jsonb`. |
| `20261122000700_invitation_projects.sql` | `user_invitations`: `project_ids uuid[]` (joined on acceptance), `phone`, `revoked_at`, `revoked_by`. |
| `20261122000800_user_suspension.sql` | `user_profiles.suspended_until`, `suspension_reason`; both added to the privileged columns users can't change on their own profile. |

**Compatibility:** all additive. The role-escalation guard refuses role changes that were previously allowed; the only legitimate case affected is a non-superadmin assigning a role with more permissions than their own.

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
