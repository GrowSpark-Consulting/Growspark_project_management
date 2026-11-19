-- ============================================================================
-- Project Management three-portal revision — Migration 2/3: shared project & task engine
-- Task workflow + review, subtasks, dependencies, task history, archive,
-- risks, deliverable flow, timesheets (+ week lock), project templates.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Projects: archive, feedback requests
--    (Budget and hourly rate live in public.project_financials, migration 4,
--     so they are never readable by people who can only read the project.)
-- ----------------------------------------------------------------------------
ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS archived_at timestamptz,
  ADD COLUMN IF NOT EXISTS feedback_requested_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_projects_active_account ON public.projects (account_id) WHERE archived_at IS NULL;

-- Archived projects are read-only for everybody except the service role
CREATE OR REPLACE FUNCTION public.user_can_contribute(pid uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT pid IS NOT NULL AND NOT public.user_is_client()
    AND NOT EXISTS (SELECT 1 FROM public.projects ap WHERE ap.id = pid AND ap.archived_at IS NOT NULL)
    AND (
         public.user_is_superadmin()
      OR public.user_has_permission('manage_all_projects')
      OR public.user_can_access_project(pid)
      OR EXISTS (SELECT 1 FROM public.projects p WHERE p.id = pid AND p.assigned_user_id = auth.uid())
      OR EXISTS (SELECT 1 FROM public.tasks t WHERE t.project_id = pid AND t.assigned_to = auth.uid())
    );
$$;

CREATE OR REPLACE FUNCTION public.task_project(tid uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT project_id FROM public.tasks WHERE id = tid;
$$;

-- ----------------------------------------------------------------------------
-- 2. Tasks: six-status workflow, review, progress, subtasks
-- ----------------------------------------------------------------------------
ALTER TABLE public.tasks DROP CONSTRAINT IF EXISTS tasks_status_check;
UPDATE public.tasks SET status = 'on_hold' WHERE status = 'blocked';
UPDATE public.tasks SET status = 'todo' WHERE status = 'backlog';
-- legacy values kept valid for one release (decision D7)
ALTER TABLE public.tasks ADD CONSTRAINT tasks_status_check
  CHECK (status IN ('todo','in_progress','on_hold','review','changes_requested','done','backlog','blocked'));
ALTER TABLE public.tasks ALTER COLUMN status SET DEFAULT 'todo';

ALTER TABLE public.tasks
  ADD COLUMN IF NOT EXISTS parent_task_id uuid REFERENCES public.tasks(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS reviewer_id uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS review_note text,
  ADD COLUMN IF NOT EXISTS progress_percent smallint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS started_at timestamptz,
  ADD COLUMN IF NOT EXISTS completed_at timestamptz;
ALTER TABLE public.tasks DROP CONSTRAINT IF EXISTS tasks_progress_check;
ALTER TABLE public.tasks ADD CONSTRAINT tasks_progress_check CHECK (progress_percent BETWEEN 0 AND 100);
ALTER TABLE public.tasks DROP CONSTRAINT IF EXISTS tasks_parent_not_self;
ALTER TABLE public.tasks ADD CONSTRAINT tasks_parent_not_self CHECK (parent_task_id IS NULL OR parent_task_id <> id);
ALTER TABLE public.tasks DROP CONSTRAINT IF EXISTS tasks_review_note_len;
ALTER TABLE public.tasks ADD CONSTRAINT tasks_review_note_len CHECK (review_note IS NULL OR char_length(review_note) <= 2000);

UPDATE public.tasks SET completed_at = COALESCE(completed_at, updated_at), progress_percent = 100
WHERE status = 'done' AND completed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_tasks_parent ON public.tasks (parent_task_id) WHERE parent_task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_assignee_status ON public.tasks (assigned_to, status);
CREATE INDEX IF NOT EXISTS idx_tasks_reviewer_review ON public.tasks (reviewer_id) WHERE status = 'review';
CREATE INDEX IF NOT EXISTS idx_tasks_due ON public.tasks (due_date) WHERE status <> 'done';

-- Subtasks: same project, one level only
CREATE OR REPLACE FUNCTION public.validate_task_parent() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE p_project uuid; p_parent uuid;
BEGIN
  IF NEW.parent_task_id IS NULL THEN RETURN NEW; END IF;
  SELECT project_id, parent_task_id INTO p_project, p_parent FROM public.tasks WHERE id = NEW.parent_task_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Parent task not found' USING ERRCODE = '23503'; END IF;
  IF p_project <> NEW.project_id THEN RAISE EXCEPTION 'Parent task must be in the same project' USING ERRCODE = '23514'; END IF;
  IF p_parent IS NOT NULL THEN RAISE EXCEPTION 'Subtasks cannot have their own subtasks' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS validate_task_parent ON public.tasks;
CREATE TRIGGER validate_task_parent BEFORE INSERT OR UPDATE OF parent_task_id, project_id ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION public.validate_task_parent();

-- Status transitions: only the reviewer (not reviewing their own task) or a
-- project manager may approve (done), request changes, or reopen a done task.
CREATE OR REPLACE FUNCTION public.enforce_task_status_transition() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE privileged boolean;
BEGIN
  privileged := auth.uid() IS NULL
    OR COALESCE(auth.role(), '') = 'service_role'
    OR public.user_can_manage_project(NEW.project_id)
    OR (TG_OP = 'UPDATE' AND OLD.reviewer_id IS NOT NULL AND OLD.reviewer_id = auth.uid()
        AND OLD.assigned_to IS DISTINCT FROM auth.uid());

  IF TG_OP = 'INSERT' THEN
    IF NEW.status IN ('done','changes_requested','review') AND NOT privileged THEN
      NEW.status := 'todo';
    END IF;
  ELSE
    IF NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
    IF (NEW.status IN ('done','changes_requested') OR OLD.status = 'done') AND NOT privileged THEN
      RAISE EXCEPTION 'Only the reviewer or a project manager can approve, request changes or reopen this task'
        USING ERRCODE = '42501';
    END IF;
    IF NEW.status = 'changes_requested' AND COALESCE(btrim(NEW.review_note), '') = '' THEN
      RAISE EXCEPTION 'A note is required when requesting changes' USING ERRCODE = '23514';
    END IF;
    IF OLD.status = 'done' AND NEW.status <> 'done' THEN NEW.completed_at := NULL; END IF;
  END IF;

  IF NEW.status = 'in_progress' AND NEW.started_at IS NULL THEN NEW.started_at := now(); END IF;
  IF NEW.status = 'done' THEN
    NEW.completed_at := COALESCE(NEW.completed_at, now());
    NEW.progress_percent := 100;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS enforce_task_status_transition ON public.tasks;
CREATE TRIGGER enforce_task_status_transition BEFORE INSERT OR UPDATE OF status ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION public.enforce_task_status_transition();

-- ----------------------------------------------------------------------------
-- 3. Task history (append-only, written by trigger)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.task_activity (
  id uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  task_id uuid NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  actor_id uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  action text NOT NULL CHECK (action IN ('created','status_changed','assigned','priority_changed','progress_updated',
                                         'review_submitted','review_approved','changes_requested','reopened')),
  from_value text,
  to_value text,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_task_activity_task ON public.task_activity (task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_task_activity_project ON public.task_activity (project_id, created_at DESC);
ALTER TABLE public.task_activity ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ta_select ON public.task_activity;
CREATE POLICY ta_select ON public.task_activity FOR SELECT USING (public.user_can_view_project(project_id));

CREATE OR REPLACE FUNCTION public.log_task_activity() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE act text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.task_activity (task_id, project_id, actor_id, action, to_value)
    VALUES (NEW.id, NEW.project_id, auth.uid(), 'created', NEW.status);
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    act := CASE
      WHEN NEW.status = 'review' THEN 'review_submitted'
      WHEN NEW.status = 'done' THEN 'review_approved'
      WHEN NEW.status = 'changes_requested' THEN 'changes_requested'
      WHEN OLD.status = 'done' THEN 'reopened'
      ELSE 'status_changed' END;
    INSERT INTO public.task_activity (task_id, project_id, actor_id, action, from_value, to_value, note)
    VALUES (NEW.id, NEW.project_id, auth.uid(), act, OLD.status, NEW.status,
            CASE WHEN act IN ('review_submitted','review_approved','changes_requested','reopened') THEN NEW.review_note END);
  END IF;
  IF NEW.assigned_to IS DISTINCT FROM OLD.assigned_to THEN
    INSERT INTO public.task_activity (task_id, project_id, actor_id, action, from_value, to_value)
    VALUES (NEW.id, NEW.project_id, auth.uid(), 'assigned', OLD.assigned_to::text, NEW.assigned_to::text);
  END IF;
  IF NEW.priority IS DISTINCT FROM OLD.priority THEN
    INSERT INTO public.task_activity (task_id, project_id, actor_id, action, from_value, to_value)
    VALUES (NEW.id, NEW.project_id, auth.uid(), 'priority_changed', OLD.priority, NEW.priority);
  END IF;
  IF NEW.progress_percent IS DISTINCT FROM OLD.progress_percent AND NEW.status <> 'done' THEN
    INSERT INTO public.task_activity (task_id, project_id, actor_id, action, from_value, to_value)
    VALUES (NEW.id, NEW.project_id, auth.uid(), 'progress_updated', OLD.progress_percent::text, NEW.progress_percent::text);
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS log_task_activity ON public.tasks;
CREATE TRIGGER log_task_activity AFTER INSERT OR UPDATE ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION public.log_task_activity();

-- ----------------------------------------------------------------------------
-- 4. Task dependencies (existing table): same project, no self / 2-cycles
-- ----------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS uq_task_dependencies_pair ON public.task_dependencies (task_id, depends_on_task_id);

CREATE OR REPLACE FUNCTION public.validate_task_dependency() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.task_id = NEW.depends_on_task_id THEN
    RAISE EXCEPTION 'A task cannot depend on itself' USING ERRCODE = '23514';
  END IF;
  IF public.task_project(NEW.task_id) IS DISTINCT FROM public.task_project(NEW.depends_on_task_id) THEN
    RAISE EXCEPTION 'Dependencies must be within the same project' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM public.task_dependencies d WHERE d.task_id = NEW.depends_on_task_id AND d.depends_on_task_id = NEW.task_id) THEN
    RAISE EXCEPTION 'This dependency would create a cycle' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS validate_task_dependency ON public.task_dependencies;
CREATE TRIGGER validate_task_dependency BEFORE INSERT OR UPDATE ON public.task_dependencies
  FOR EACH ROW EXECUTE FUNCTION public.validate_task_dependency();

DROP POLICY IF EXISTS "Users can view task dependencies" ON public.task_dependencies;
DROP POLICY IF EXISTS "Users can manage task dependencies" ON public.task_dependencies;
DROP POLICY IF EXISTS td_select ON public.task_dependencies;
DROP POLICY IF EXISTS td_write ON public.task_dependencies;
CREATE POLICY td_select ON public.task_dependencies FOR SELECT USING (public.user_can_view_project(public.task_project(task_id)));
CREATE POLICY td_write ON public.task_dependencies FOR ALL
  USING (public.user_can_contribute(public.task_project(task_id)))
  WITH CHECK (public.user_can_contribute(public.task_project(task_id)));

-- ----------------------------------------------------------------------------
-- 5. Issues & risks
-- ----------------------------------------------------------------------------
ALTER TABLE public.project_issues
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'issue',
  ADD COLUMN IF NOT EXISTS severity text NOT NULL DEFAULT 'medium',
  ADD COLUMN IF NOT EXISTS title text,
  ADD COLUMN IF NOT EXISTS client_visible boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS resolution_note text;
ALTER TABLE public.project_issues DROP CONSTRAINT IF EXISTS project_issues_kind_check;
ALTER TABLE public.project_issues ADD CONSTRAINT project_issues_kind_check CHECK (kind IN ('issue','risk'));
ALTER TABLE public.project_issues DROP CONSTRAINT IF EXISTS project_issues_severity_check;
ALTER TABLE public.project_issues ADD CONSTRAINT project_issues_severity_check CHECK (severity IN ('low','medium','high','critical'));
UPDATE public.project_issues pi SET client_visible = true
WHERE client_visible = false AND EXISTS (SELECT 1 FROM public.user_profiles up WHERE up.id = pi.created_by AND up.is_client = true);
CREATE INDEX IF NOT EXISTS idx_project_issues_kind ON public.project_issues (project_id, kind, status);

-- ----------------------------------------------------------------------------
-- 6. Deliverables: draft → pending_review → client_review → approved/rejected → revised
-- ----------------------------------------------------------------------------
ALTER TABLE public.deliverables DROP CONSTRAINT IF EXISTS deliverables_status_check;
ALTER TABLE public.deliverables ADD CONSTRAINT deliverables_status_check
  CHECK (status IN ('draft','pending_review','client_review','approved','rejected','revised'));
ALTER TABLE public.deliverables
  ADD COLUMN IF NOT EXISTS shared_at timestamptz,
  ADD COLUMN IF NOT EXISTS shared_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_deliverables_project_status ON public.deliverables (project_id, status);
DROP POLICY IF EXISTS dl_select_team ON public.deliverables;
DROP POLICY IF EXISTS dl_insert_team ON public.deliverables;
DROP POLICY IF EXISTS dl_update_manager ON public.deliverables;
DROP POLICY IF EXISTS dl_delete_manager ON public.deliverables;
CREATE POLICY dl_select_team ON public.deliverables FOR SELECT USING (public.user_can_view_project(project_id));
CREATE POLICY dl_insert_team ON public.deliverables FOR INSERT WITH CHECK (public.user_can_contribute(project_id));
CREATE POLICY dl_update_manager ON public.deliverables FOR UPDATE USING (public.user_can_manage_project(project_id));
CREATE POLICY dl_delete_manager ON public.deliverables FOR DELETE USING (public.user_can_manage_project(project_id));

-- ----------------------------------------------------------------------------
-- 7. Timesheets (+ lock of submitted/approved weeks)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.timesheets (
  id uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  user_id uuid NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
  week_start_date date NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','approved','rejected')),
  total_hours numeric(6,2),
  submitted_at timestamptz,
  reviewed_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  review_note text CHECK (review_note IS NULL OR char_length(review_note) <= 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, week_start_date)
);
CREATE INDEX IF NOT EXISTS idx_timesheets_status_week ON public.timesheets (status, week_start_date);

CREATE OR REPLACE FUNCTION public.user_can_approve_timesheet_of(uid uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT uid IS NOT NULL AND uid <> auth.uid() AND NOT public.user_is_client() AND (
       public.user_is_superadmin()
    OR public.user_has_permission('view_all_time_entries')
    OR (public.user_has_permission('approve_timesheets') AND EXISTS (
          SELECT 1 FROM public.time_entries te
          WHERE te.user_id = uid AND public.user_can_contribute(te.project_id)))
  );
$$;

ALTER TABLE public.timesheets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tsh_select ON public.timesheets;
DROP POLICY IF EXISTS tsh_insert ON public.timesheets;
DROP POLICY IF EXISTS tsh_update ON public.timesheets;
CREATE POLICY tsh_select ON public.timesheets FOR SELECT USING (user_id = auth.uid() OR public.user_can_approve_timesheet_of(user_id));
CREATE POLICY tsh_insert ON public.timesheets FOR INSERT WITH CHECK (user_id = auth.uid());
CREATE POLICY tsh_update ON public.timesheets FOR UPDATE USING (user_id = auth.uid() OR public.user_can_approve_timesheet_of(user_id));

CREATE OR REPLACE FUNCTION public.enforce_timesheet_lock() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF auth.uid() IS NULL OR COALESCE(auth.role(), '') = 'service_role' OR public.user_is_superadmin() THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP IN ('UPDATE','DELETE') AND EXISTS (
      SELECT 1 FROM public.timesheets t
      WHERE t.user_id = OLD.user_id AND t.week_start_date = OLD.week_start_date AND t.status IN ('submitted','approved')) THEN
    RAISE EXCEPTION 'This week''s timesheet has been submitted and is locked' USING ERRCODE = '55006';
  END IF;
  IF TG_OP IN ('INSERT','UPDATE') AND EXISTS (
      SELECT 1 FROM public.timesheets t
      WHERE t.user_id = NEW.user_id AND t.week_start_date = NEW.week_start_date AND t.status IN ('submitted','approved')) THEN
    RAISE EXCEPTION 'This week''s timesheet has been submitted and is locked' USING ERRCODE = '55006';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;
DROP TRIGGER IF EXISTS enforce_timesheet_lock ON public.time_entries;
CREATE TRIGGER enforce_timesheet_lock BEFORE INSERT OR UPDATE OR DELETE ON public.time_entries
  FOR EACH ROW EXECUTE FUNCTION public.enforce_timesheet_lock();

-- ----------------------------------------------------------------------------
-- 8. Project templates
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.project_templates (
  id uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  description text,
  blueprint jsonb NOT NULL DEFAULT '{"tasks":[],"milestones":[],"dependencies":[]}'::jsonb,
  default_workflow_template_id uuid REFERENCES public.workflow_templates(id) ON DELETE SET NULL,
  created_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.project_templates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pt_select ON public.project_templates;
DROP POLICY IF EXISTS pt_insert ON public.project_templates;
DROP POLICY IF EXISTS pt_modify ON public.project_templates;
DROP POLICY IF EXISTS pt_delete ON public.project_templates;
CREATE POLICY pt_select ON public.project_templates FOR SELECT USING (auth.uid() IS NOT NULL AND NOT public.user_is_client());
CREATE POLICY pt_insert ON public.project_templates FOR INSERT
  WITH CHECK (public.user_is_superadmin() OR public.user_has_permission('manage_projects') OR public.user_has_permission('manage_all_projects'));
CREATE POLICY pt_modify ON public.project_templates FOR UPDATE
  USING (created_by = auth.uid() OR public.user_is_superadmin() OR public.user_has_permission('manage_all_projects'));
CREATE POLICY pt_delete ON public.project_templates FOR DELETE
  USING (created_by = auth.uid() OR public.user_is_superadmin() OR public.user_has_permission('manage_all_projects'));
