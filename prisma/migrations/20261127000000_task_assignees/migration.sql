-- Tasks with several assignees (shared database, schema `project`). Same content as
-- supabase/migrations/20261127000000_task_assignees.sql, written for this schema (project.current_user_id() instead of
-- auth.uid()), plus the grants and the project_system policy the other tables have.
--
-- Apply as project_migrator (owner of the tables):  npx prisma migrate deploy
-- Additive: one new table, new functions and triggers, one CHECK constraint widened, enforce_task_field_rules()
-- replaced (same rules plus two additions), and one INSERT backfilling a row per existing assigned task.
-- Undo: see the end of this file. Do NOT apply to the shared database without approval.

-- ============================================================================
-- Tasks with several assignees
-- ============================================================================
-- Until now a task had one assignee (tasks.assigned_to). This adds task_assignees: one row per person on a
-- task, each with their OWN status, progress, work report and blocker. The task stays one task (same id,
-- title, dates, project); its progress is the average of its assignees' progress, and it is complete when
-- every assignee has completed their part (the app moves it to review / done; a manager can override).
--
-- Backward compatible:
--   * tasks.assigned_to stays, as the "primary" assignee (the earliest one). Everything that reads it keeps working.
--   * Existing single-assignee tasks are backfilled with one task_assignees row that mirrors the task.
--   * Code that still sets tasks.assigned_to (the previous release) keeps working: a trigger turns it into the
--     task's single assignee, and for a one-assignee task the row follows the task's status and progress.
--
-- Who may assign whom (also enforced by the API): a project manager can assign people whose highest role level
-- (roles.hierarchy_level) is LOWER than their own, and themselves; anyone else can only assign themselves;
-- superadmins are unrestricted. Same level or above cannot be assigned. At most 10 assignees per task.
-- ============================================================================

CREATE TABLE IF NOT EXISTS project.task_assignees (
  task_id          uuid NOT NULL REFERENCES project.tasks(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES project.user_profiles(id) ON DELETE CASCADE,
  assigned_by      uuid REFERENCES project.user_profiles(id) ON DELETE SET NULL,
  assigned_at      timestamptz NOT NULL DEFAULT now(),
  status           text NOT NULL DEFAULT 'todo',
  progress_percent smallint NOT NULL DEFAULT 0,
  report           text,
  blocker          text,
  completed_at     timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, user_id),
  CONSTRAINT task_assignees_status_check CHECK (status IN ('todo', 'in_progress', 'blocked', 'done')),
  CONSTRAINT task_assignees_progress_check CHECK (progress_percent BETWEEN 0 AND 100)
);

-- "My tasks": the tasks a person is on
CREATE INDEX IF NOT EXISTS task_assignees_user_idx ON project.task_assignees (user_id, task_id);

ALTER TABLE project.task_assignees ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS task_assignees_select ON project.task_assignees;
CREATE POLICY task_assignees_select ON project.task_assignees
  FOR SELECT USING (project.user_can_view_project(project.task_project(task_id)));

DROP POLICY IF EXISTS task_assignees_insert ON project.task_assignees;
CREATE POLICY task_assignees_insert ON project.task_assignees
  FOR INSERT WITH CHECK (project.user_can_contribute(project.task_project(task_id)));

DROP POLICY IF EXISTS task_assignees_update ON project.task_assignees;
CREATE POLICY task_assignees_update ON project.task_assignees
  FOR UPDATE USING (user_id = project.current_user_id() OR project.user_can_manage_project(project.task_project(task_id)))
  WITH CHECK (user_id = project.current_user_id() OR project.user_can_manage_project(project.task_project(task_id)));

DROP POLICY IF EXISTS task_assignees_delete ON project.task_assignees;
CREATE POLICY task_assignees_delete ON project.task_assignees
  FOR DELETE USING (
    project.user_can_manage_project(project.task_project(task_id))
    OR (user_id = project.current_user_id() AND EXISTS (SELECT 1 FROM project.tasks t WHERE t.id = task_id AND t.created_by = project.current_user_id()))
  );


-- Activity log: assignee changes and reports
ALTER TABLE project.task_activity DROP CONSTRAINT IF EXISTS task_activity_action_check;
ALTER TABLE project.task_activity ADD CONSTRAINT task_activity_action_check CHECK (action = ANY (ARRAY[
  'created', 'status_changed', 'assigned', 'priority_changed', 'progress_updated', 'review_submitted',
  'review_approved', 'changes_requested', 'reopened', 'assignee_added', 'assignee_removed', 'report_updated']));

-- ---------------------------------------------------------------------------
-- Hierarchy
-- ---------------------------------------------------------------------------
-- A person's level: the highest roles.hierarchy_level among their roles (superadmins: 100)
CREATE OR REPLACE FUNCTION project.user_max_role_level(uid uuid) RETURNS integer
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'project', 'pg_temp'
    AS $$
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM project.user_profiles up WHERE up.id = uid AND up.is_superadmin) THEN 100
    ELSE COALESCE((SELECT max(r.hierarchy_level) FROM project.user_roles ur JOIN project.roles r ON r.id = ur.role_id
                   WHERE ur.user_id = uid), 0)
  END;
$$;

-- May the signed-in person put `assignee` on a task of project `pid`?
CREATE OR REPLACE FUNCTION project.can_assign_task_to(pid uuid, assignee uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'project', 'pg_temp'
    AS $$
  SELECT project.caller_is_trusted()
      OR assignee = project.current_user_id()
      OR project.user_is_superadmin()
      OR (project.user_can_manage_project(pid)
          AND project.user_max_role_level(project.current_user_id()) > project.user_max_role_level(assignee));
$$;

-- ---------------------------------------------------------------------------
-- Rules for changes to task_assignees (signed-in callers; server jobs are trusted)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION project.enforce_task_assignee_rules() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'project', 'pg_temp'
    AS $$
DECLARE
  t record;
  manager boolean;
  n integer;
BEGIN
  IF project.caller_is_trusted() OR COALESCE(pg_catalog.current_setting('app.assignee_sync', true), '') = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  SELECT project_id, created_by, reviewer_id INTO t FROM project.tasks WHERE id = COALESCE(NEW.task_id, OLD.task_id);
  manager := project.user_can_manage_project(t.project_id);

  IF TG_OP = 'INSERT' THEN
    NEW.assigned_by := project.current_user_id();
    NEW.assigned_at := now();
    NEW.status := 'todo';
    NEW.progress_percent := 0;
    NEW.report := NULL;
    NEW.blocker := NULL;
    NEW.completed_at := NULL;
    NEW.updated_at := now();
    IF NOT project.user_is_valid_task_member(t.project_id, NEW.user_id) THEN
      RAISE EXCEPTION 'Assignee must be an active internal member of this project team' USING ERRCODE = '23514';
    END IF;
    IF NOT project.can_assign_task_to(t.project_id, NEW.user_id) THEN
      RAISE EXCEPTION 'You can only assign tasks to people below you in the role hierarchy, or to yourself' USING ERRCODE = '42501';
    END IF;
    IF t.reviewer_id IS NOT NULL AND t.reviewer_id = NEW.user_id THEN
      RAISE EXCEPTION 'The reviewer cannot be the person assigned to the task' USING ERRCODE = '23514';
    END IF;
    SELECT count(*) INTO n FROM project.task_assignees WHERE task_id = NEW.task_id;
    IF n >= 10 THEN
      RAISE EXCEPTION 'A task can have at most 10 assignees' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.task_id IS DISTINCT FROM OLD.task_id OR NEW.user_id IS DISTINCT FROM OLD.user_id
       OR NEW.assigned_by IS DISTINCT FROM OLD.assigned_by OR NEW.assigned_at IS DISTINCT FROM OLD.assigned_at THEN
      RAISE EXCEPTION 'Who is assigned to a task cannot be changed; remove and add instead' USING ERRCODE = '42501';
    END IF;
    IF NOT manager AND OLD.user_id IS DISTINCT FROM project.current_user_id() THEN
      RAISE EXCEPTION 'You can only update your own part of a task' USING ERRCODE = '42501';
    END IF;
    IF NEW.status = 'done' AND OLD.status <> 'done' THEN
      NEW.completed_at := COALESCE(NEW.completed_at, now());
      NEW.progress_percent := 100;
    ELSIF NEW.status <> 'done' THEN
      NEW.completed_at := NULL;
    END IF;
    NEW.updated_at := now();
    RETURN NEW;
  END IF;

  -- DELETE
  IF manager OR (t.created_by = project.current_user_id() AND OLD.user_id = project.current_user_id()) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Only a project manager can remove an assignee' USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS enforce_task_assignee_rules ON project.task_assignees;
CREATE TRIGGER enforce_task_assignee_rules BEFORE INSERT OR UPDATE OR DELETE ON project.task_assignees
  FOR EACH ROW EXECUTE FUNCTION project.enforce_task_assignee_rules();

-- ---------------------------------------------------------------------------
-- Keep the task in step with its assignees: the primary assignee and the average progress
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION project.sync_task_from_assignees() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'project', 'pg_temp'
    AS $$
DECLARE
  tid uuid;
  n integer;
  avg_progress integer;
  primary_user uuid;
BEGIN
  IF COALESCE(pg_catalog.current_setting('app.assignee_sync', true), '') = 'on' THEN
    RETURN NULL;
  END IF;
  tid := COALESCE(NEW.task_id, OLD.task_id);
  PERFORM pg_catalog.set_config('app.assignee_sync', 'on', true);
  SELECT count(*), COALESCE(round(avg(progress_percent))::integer, 0), (array_agg(user_id ORDER BY assigned_at, user_id))[1]
    INTO n, avg_progress, primary_user
    FROM project.task_assignees WHERE task_id = tid;
  UPDATE project.tasks
     SET assigned_to = primary_user,
         progress_percent = CASE WHEN n = 0 THEN progress_percent ELSE avg_progress END
   WHERE id = tid
     AND (assigned_to IS DISTINCT FROM primary_user OR (n > 0 AND progress_percent IS DISTINCT FROM avg_progress));
  PERFORM pg_catalog.set_config('app.assignee_sync', 'off', true);
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS sync_task_from_assignees ON project.task_assignees;
CREATE TRIGGER sync_task_from_assignees AFTER INSERT OR UPDATE OR DELETE ON project.task_assignees
  FOR EACH ROW EXECUTE FUNCTION project.sync_task_from_assignees();

-- ---------------------------------------------------------------------------
-- The other way: code that sets tasks.assigned_to / status / progress directly (the previous release, and the
-- task-level actions: approve, request changes, reopen) is reflected in the assignee rows
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION project.assignee_status_of(task_status text) RETURNS text
    LANGUAGE sql IMMUTABLE
    AS $$
  SELECT CASE
    WHEN task_status IN ('review', 'done') THEN 'done'
    WHEN task_status IN ('in_progress', 'changes_requested') THEN 'in_progress'
    WHEN task_status IN ('on_hold', 'blocked') THEN 'blocked'
    ELSE 'todo'
  END;
$$;

CREATE OR REPLACE FUNCTION project.mirror_task_to_assignees() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'project', 'pg_temp'
    AS $$
DECLARE
  n integer;
  mapped text;
BEGIN
  IF COALESCE(pg_catalog.current_setting('app.assignee_sync', true), '') = 'on' THEN
    RETURN NULL;
  END IF;
  PERFORM pg_catalog.set_config('app.assignee_sync', 'on', true);
  mapped := project.assignee_status_of(NEW.status);

  IF TG_OP = 'INSERT' THEN
    IF NEW.assigned_to IS NOT NULL THEN
      INSERT INTO project.task_assignees (task_id, user_id, assigned_by, status, progress_percent, completed_at)
      VALUES (NEW.id, NEW.assigned_to, NEW.created_by, mapped, NEW.progress_percent,
              CASE WHEN mapped = 'done' THEN COALESCE(NEW.completed_at, now()) END)
      ON CONFLICT (task_id, user_id) DO NOTHING;
    END IF;
  ELSE
    IF NEW.assigned_to IS DISTINCT FROM OLD.assigned_to THEN
      -- A direct change of tasks.assigned_to means "this one person is the task's assignee"
      DELETE FROM project.task_assignees
       WHERE task_id = NEW.id AND (NEW.assigned_to IS NULL OR user_id <> NEW.assigned_to);
      IF NEW.assigned_to IS NOT NULL THEN
        INSERT INTO project.task_assignees (task_id, user_id, assigned_by, status, progress_percent, completed_at)
        VALUES (NEW.id, NEW.assigned_to, COALESCE(project.current_user_id(), NEW.created_by), mapped, NEW.progress_percent,
                CASE WHEN mapped = 'done' THEN COALESCE(NEW.completed_at, now()) END)
        ON CONFLICT (task_id, user_id) DO NOTHING;
      END IF;
    END IF;

    IF NEW.status IS DISTINCT FROM OLD.status OR NEW.progress_percent IS DISTINCT FROM OLD.progress_percent THEN
      SELECT count(*) INTO n FROM project.task_assignees WHERE task_id = NEW.id;
      IF n = 1 THEN
        UPDATE project.task_assignees
           SET status = mapped, progress_percent = NEW.progress_percent,
               completed_at = CASE WHEN mapped = 'done' THEN COALESCE(completed_at, now()) END, updated_at = now()
         WHERE task_id = NEW.id;
      ELSIF n > 1 AND NEW.status = 'done' AND OLD.status IS DISTINCT FROM 'done' THEN
        -- approved, or a manager marked the whole task done: everyone's part is done
        UPDATE project.task_assignees
           SET status = 'done', progress_percent = 100, completed_at = COALESCE(completed_at, now()), updated_at = now()
         WHERE task_id = NEW.id AND status <> 'done';
      ELSIF n > 1 AND (NEW.status = 'changes_requested' OR (OLD.status = 'done' AND NEW.status <> 'done')) THEN
        -- changes requested, or reopened: everyone's part is open again
        UPDATE project.task_assignees
           SET status = 'in_progress', completed_at = NULL, updated_at = now()
         WHERE task_id = NEW.id AND status = 'done';
      END IF;
    END IF;
  END IF;
  PERFORM pg_catalog.set_config('app.assignee_sync', 'off', true);
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS mirror_task_to_assignees ON project.tasks;
CREATE TRIGGER mirror_task_to_assignees AFTER INSERT OR UPDATE OF assigned_to, status, progress_percent ON project.tasks
  FOR EACH ROW EXECUTE FUNCTION project.mirror_task_to_assignees();

-- ---------------------------------------------------------------------------
-- The task field rules, with two additions: changes made by the sync triggers above are not "reassigning", and
-- the reviewer cannot be any of the task's assignees
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION project.enforce_task_field_rules() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'project', 'pg_temp'
    AS $$
DECLARE
  is_manager boolean;
  is_creator boolean;
BEGIN
  IF project.caller_is_trusted() OR COALESCE(pg_catalog.current_setting('app.assignee_sync', true), '') = 'on' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.created_by := project.current_user_id();
    is_manager := project.user_can_manage_project(NEW.project_id);
    IF NEW.assigned_to IS NOT NULL AND NOT project.user_is_valid_task_member(NEW.project_id, NEW.assigned_to) THEN
      RAISE EXCEPTION 'Assignee must be an active internal member of this project team' USING ERRCODE = '23514';
    END IF;
    IF NEW.reviewer_id IS NOT NULL THEN
      IF NOT is_manager THEN
        RAISE EXCEPTION 'Only a project manager can choose the reviewer' USING ERRCODE = '42501';
      END IF;
      IF NOT project.user_is_valid_task_member(NEW.project_id, NEW.reviewer_id) THEN
        RAISE EXCEPTION 'Reviewer must be an active internal member of this project team' USING ERRCODE = '23514';
      END IF;
      IF NEW.reviewer_id = NEW.assigned_to THEN
        RAISE EXCEPTION 'The reviewer cannot be the person assigned to the task' USING ERRCODE = '23514';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE
  IF NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'The task creator cannot be changed' USING ERRCODE = '42501';
  END IF;

  is_manager := project.user_can_manage_project(OLD.project_id);
  IF NOT is_manager THEN
    is_creator := OLD.created_by IS NOT DISTINCT FROM project.current_user_id();

    IF NEW.project_id IS DISTINCT FROM OLD.project_id THEN
      RAISE EXCEPTION 'Only a project manager can move a task to another project' USING ERRCODE = '42501';
    END IF;

    IF NOT is_creator AND (
         NEW.name            IS DISTINCT FROM OLD.name
      OR NEW.priority        IS DISTINCT FROM OLD.priority
      OR NEW.start_date      IS DISTINCT FROM OLD.start_date
      OR NEW.due_date        IS DISTINCT FROM OLD.due_date
      OR NEW.estimated_hours IS DISTINCT FROM OLD.estimated_hours
      OR NEW.parent_task_id  IS DISTINCT FROM OLD.parent_task_id) THEN
      RAISE EXCEPTION 'Only the task creator or a project manager can change the title, priority, dates or estimate'
        USING ERRCODE = '42501';
    END IF;

    IF NEW.assigned_to IS DISTINCT FROM OLD.assigned_to AND NOT is_creator
       AND NOT (OLD.assigned_to IS NULL AND NEW.assigned_to = project.current_user_id()) THEN
      RAISE EXCEPTION 'Only the task creator or a project manager can reassign this task' USING ERRCODE = '42501';
    END IF;

    IF NEW.reviewer_id IS DISTINCT FROM OLD.reviewer_id THEN
      RAISE EXCEPTION 'Only a project manager can choose the reviewer' USING ERRCODE = '42501';
    END IF;
  END IF;

  IF NEW.assigned_to IS DISTINCT FROM OLD.assigned_to AND NEW.assigned_to IS NOT NULL
     AND NOT project.user_is_valid_task_member(NEW.project_id, NEW.assigned_to) THEN
    RAISE EXCEPTION 'Assignee must be an active internal member of this project team' USING ERRCODE = '23514';
  END IF;
  IF NEW.reviewer_id IS DISTINCT FROM OLD.reviewer_id AND NEW.reviewer_id IS NOT NULL
     AND NOT project.user_is_valid_task_member(NEW.project_id, NEW.reviewer_id) THEN
    RAISE EXCEPTION 'Reviewer must be an active internal member of this project team' USING ERRCODE = '23514';
  END IF;
  IF NEW.reviewer_id IS NOT NULL AND NEW.reviewer_id = NEW.assigned_to
     AND (NEW.reviewer_id IS DISTINCT FROM OLD.reviewer_id OR NEW.assigned_to IS DISTINCT FROM OLD.assigned_to) THEN
    RAISE EXCEPTION 'The reviewer cannot be the person assigned to the task' USING ERRCODE = '23514';
  END IF;
  IF NEW.reviewer_id IS NOT NULL AND NEW.reviewer_id IS DISTINCT FROM OLD.reviewer_id
     AND EXISTS (SELECT 1 FROM project.task_assignees ta WHERE ta.task_id = NEW.id AND ta.user_id = NEW.reviewer_id) THEN
    RAISE EXCEPTION 'The reviewer cannot be the person assigned to the task' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- Existing tasks: one assignee row for every task that has an assignee (mirrors the task)
-- ---------------------------------------------------------------------------
SELECT pg_catalog.set_config('app.assignee_sync', 'on', true);
INSERT INTO project.task_assignees (task_id, user_id, assigned_by, assigned_at, status, progress_percent, completed_at)
SELECT t.id, t.assigned_to, t.created_by, t.created_at, project.assignee_status_of(t.status),
       LEAST(100, GREATEST(0, COALESCE(t.progress_percent, 0))),
       CASE WHEN project.assignee_status_of(t.status) = 'done' THEN COALESCE(t.completed_at, t.updated_at) END
  FROM project.tasks t
 WHERE t.assigned_to IS NOT NULL
ON CONFLICT (task_id, user_id) DO NOTHING;
SELECT pg_catalog.set_config('app.assignee_sync', 'off', true);

-- ---------------------------------------------------------------------------
-- Access for the app's database roles (same as the other tables)
-- ---------------------------------------------------------------------------
GRANT ALL ON TABLE project.task_assignees TO project_user;
GRANT ALL ON TABLE project.task_assignees TO project_system;
CREATE POLICY project_system_all ON project.task_assignees TO project_system USING (true) WITH CHECK (true);
GRANT ALL ON FUNCTION project.user_max_role_level(uid uuid) TO project_anon, project_user, project_system;
GRANT ALL ON FUNCTION project.can_assign_task_to(pid uuid, assignee uuid) TO project_anon, project_user, project_system;
GRANT ALL ON FUNCTION project.assignee_status_of(task_status text) TO project_anon, project_user, project_system;
GRANT ALL ON FUNCTION project.enforce_task_assignee_rules() TO project_anon, project_user, project_system;
GRANT ALL ON FUNCTION project.sync_task_from_assignees() TO project_anon, project_user, project_system;
GRANT ALL ON FUNCTION project.mirror_task_to_assignees() TO project_anon, project_user, project_system;

-- ---------------------------------------------------------------------------
-- UNDO (as project_migrator), in this order:
--   DROP TRIGGER mirror_task_to_assignees ON project.tasks;
--   DROP TABLE project.task_assignees;   -- also drops its triggers and policies
--   DROP FUNCTION project.mirror_task_to_assignees(), project.sync_task_from_assignees(), project.enforce_task_assignee_rules(),
--     project.assignee_status_of(text), project.can_assign_task_to(uuid, uuid), project.user_max_role_level(uuid);
--   then re-run the enforce_task_field_rules() definition from 20261124000000_project_baseline and, if wanted,
--   narrow task_activity_action_check back to its original nine actions.
-- tasks.assigned_to was never removed, so single-assignee behaviour is unaffected by the undo.
-- ---------------------------------------------------------------------------
