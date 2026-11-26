-- Indexes for server-side pagination (Admin Time Tracking, Projects, My Tasks, Notifications, Project updates,
-- Comments, Admin Users, Accounts, Invitations, Client feedback). Each serves a list's WHERE + ORDER BY so a page
-- is read from the index (LIMIT/OFFSET or keyset) instead of sorting the whole table.
--
-- Adds indexes only: no table, column, policy or data changes. Safe to run twice (IF NOT EXISTS).
-- Apply as project_migrator (owner of the tables):  npx prisma migrate deploy
-- Locks: CREATE INDEX blocks writes to that table while it builds. These tables are small today (builds take
-- milliseconds); on a large table build with CREATE INDEX CONCURRENTLY outside a transaction instead.
-- Undo: DROP INDEX IF EXISTS for each name below.

-- Admin Time Tracking: newest first across everyone, optionally one person
CREATE INDEX IF NOT EXISTS idx_time_entries_paging ON project.time_entries USING btree (entry_date DESC, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_time_entries_user_paging ON project.time_entries USING btree (user_id, entry_date DESC, created_at DESC);

-- My Tasks: my tasks by deadline; tasks I created
CREATE INDEX IF NOT EXISTS idx_tasks_assignee_due ON project.tasks USING btree (assigned_to, due_date);
CREATE INDEX IF NOT EXISTS idx_tasks_created_by ON project.tasks USING btree (created_by);

-- Projects: open, unarchived projects newest first
CREATE INDEX IF NOT EXISTS idx_projects_open_paging ON project.projects USING btree (created_at DESC, id) WHERE (archived_at IS NULL);

-- Notifications: keyset "load more" for one person
CREATE INDEX IF NOT EXISTS idx_notifications_user_keyset ON project.notifications USING btree (user_id, created_at DESC, id DESC);

-- Project updates and files: keyset "load more" per project
CREATE INDEX IF NOT EXISTS idx_project_updates_keyset ON project.project_updates USING btree (project_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_project_files_keyset ON project.project_files USING btree (project_id, created_at DESC, id DESC);

-- Comments: newest threads first (top-level comments of a task / of an update)
CREATE INDEX IF NOT EXISTS idx_comments_task_threads ON project.comments USING btree (task_id, created_at DESC, id DESC) WHERE (task_id IS NOT NULL AND parent_id IS NULL);
CREATE INDEX IF NOT EXISTS idx_comments_update_threads ON project.comments USING btree (update_id, created_at DESC, id DESC) WHERE (update_id IS NOT NULL AND parent_id IS NULL);

-- Audit log: keyset on (created_at, id)
CREATE INDEX IF NOT EXISTS idx_audit_log_keyset ON project.audit_log USING btree (created_at DESC, id DESC);

-- Admin Users, Accounts: alphabetical pages
CREATE INDEX IF NOT EXISTS idx_user_profiles_name_paging ON project.user_profiles USING btree (name, id);
CREATE INDEX IF NOT EXISTS idx_accounts_name_paging ON project.accounts USING btree (name, id);

-- Invitations, Client feedback: newest first
CREATE INDEX IF NOT EXISTS idx_user_invitations_paging ON project.user_invitations USING btree (created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_user_invitations_inviter ON project.user_invitations USING btree (invited_by, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_client_feedback_paging ON project.client_feedback USING btree (submitted_at DESC, id DESC);
