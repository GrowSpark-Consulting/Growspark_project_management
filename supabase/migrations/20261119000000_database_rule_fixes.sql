-- ============================================================================
-- Project Management three-portal revision — Migration 4/4: database rule fixes
--
-- Enforces in PostgreSQL rules that were previously enforced only by API routes
-- (a signed-in user can call Supabase directly with their own session):
--   G-1  task fields, assignee and reviewer rules (no self-approval)
--   G-2  dependency cycles of any length
--   G-3  timesheets: owners may only submit; only approvers decide
--   G-4  client-visible project updates / issues: project managers only
--   G-5  deliverables (status, approval, file) and project files (sharing, storage path)
--   G-6  budget and hourly rate moved to a manager-only table
-- Fixes schema drift used by existing workflow code:
--   D-1  projects.completed_at + project completes when its workflow completes
--   D-3  projects.workflow_instance_id (plain column; see note)
--
-- Additive only: no data is deleted and no columns are dropped.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 0. Trusted caller: the server using the service-role key, or SQL run without
--    a JWT (migrations, SQL editor). Signed-in users and anon are never trusted.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.caller_is_trusted() RETURNS boolean
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT COALESCE(auth.role(), '') = 'service_role'
      OR (auth.uid() IS NULL AND COALESCE(auth.role(), '') NOT IN ('anon', 'authenticated'));
$$;

-- Active internal user who is on the project team (mirrors assertValidAssignee in lib/api/context.ts)
CREATE OR REPLACE FUNCTION public.user_is_valid_task_member(pid uuid, uid uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT uid IS NOT NULL
    AND EXISTS (SELECT 1 FROM public.user_profiles up
                WHERE up.id = uid AND NOT COALESCE(up.is_client, false) AND up.is_active IS NOT FALSE)
    AND (
         EXISTS (SELECT 1 FROM public.projects p WHERE p.id = pid AND (p.created_by = uid OR p.assigned_user_id = uid))
      OR EXISTS (SELECT 1 FROM public.project_assignments pa
                 WHERE pa.project_id = pid AND pa.user_id = uid AND pa.removed_at IS NULL)
    );
$$;

-- ----------------------------------------------------------------------------
-- G-1. Task field rules
--   * creator cannot be changed; on insert it is always the caller
--   * details (title, priority, dates, estimate, parent): creator or project manager
--   * moving a task to another project: project manager
--   * assignee: creator or project manager; anyone may take an unassigned task
--   * reviewer: project manager only (so nobody can pick a friendly reviewer or
--     name themselves reviewer of work they did)
--   * assignee and reviewer must be active internal members of the project team
--   * reviewer cannot be the assignee
-- Status transitions stay in enforce_task_status_transition (migration 2).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_task_field_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  is_manager boolean;
  is_creator boolean;
BEGIN
  IF public.caller_is_trusted() THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.created_by := auth.uid();
    is_manager := public.user_can_manage_project(NEW.project_id);
    IF NEW.assigned_to IS NOT NULL AND NOT public.user_is_valid_task_member(NEW.project_id, NEW.assigned_to) THEN
      RAISE EXCEPTION 'Assignee must be an active internal member of this project team' USING ERRCODE = '23514';
    END IF;
    IF NEW.reviewer_id IS NOT NULL THEN
      IF NOT is_manager THEN
        RAISE EXCEPTION 'Only a project manager can choose the reviewer' USING ERRCODE = '42501';
      END IF;
      IF NOT public.user_is_valid_task_member(NEW.project_id, NEW.reviewer_id) THEN
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

  is_manager := public.user_can_manage_project(OLD.project_id);
  IF NOT is_manager THEN
    is_creator := OLD.created_by IS NOT DISTINCT FROM auth.uid();

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
       AND NOT (OLD.assigned_to IS NULL AND NEW.assigned_to = auth.uid()) THEN
      RAISE EXCEPTION 'Only the task creator or a project manager can reassign this task' USING ERRCODE = '42501';
    END IF;

    IF NEW.reviewer_id IS DISTINCT FROM OLD.reviewer_id THEN
      RAISE EXCEPTION 'Only a project manager can choose the reviewer' USING ERRCODE = '42501';
    END IF;
  END IF;

  IF NEW.assigned_to IS DISTINCT FROM OLD.assigned_to AND NEW.assigned_to IS NOT NULL
     AND NOT public.user_is_valid_task_member(NEW.project_id, NEW.assigned_to) THEN
    RAISE EXCEPTION 'Assignee must be an active internal member of this project team' USING ERRCODE = '23514';
  END IF;
  IF NEW.reviewer_id IS DISTINCT FROM OLD.reviewer_id AND NEW.reviewer_id IS NOT NULL
     AND NOT public.user_is_valid_task_member(NEW.project_id, NEW.reviewer_id) THEN
    RAISE EXCEPTION 'Reviewer must be an active internal member of this project team' USING ERRCODE = '23514';
  END IF;
  IF NEW.reviewer_id IS NOT NULL AND NEW.reviewer_id = NEW.assigned_to
     AND (NEW.reviewer_id IS DISTINCT FROM OLD.reviewer_id OR NEW.assigned_to IS DISTINCT FROM OLD.assigned_to) THEN
    RAISE EXCEPTION 'The reviewer cannot be the person assigned to the task' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS enforce_task_field_rules ON public.tasks;
CREATE TRIGGER enforce_task_field_rules BEFORE INSERT OR UPDATE ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION public.enforce_task_field_rules();

-- ----------------------------------------------------------------------------
-- G-2. Dependencies: reject cycles of any length (replaces the 2-cycle check).
--      Serialised per project so two concurrent inserts cannot form a cycle.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.validate_task_dependency() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE pid uuid;
BEGIN
  IF NEW.task_id = NEW.depends_on_task_id THEN
    RAISE EXCEPTION 'A task cannot depend on itself' USING ERRCODE = '23514';
  END IF;
  pid := public.task_project(NEW.task_id);
  IF pid IS DISTINCT FROM public.task_project(NEW.depends_on_task_id) THEN
    RAISE EXCEPTION 'Dependencies must be within the same project' USING ERRCODE = '23514';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('task_dependencies:' || pid::text));
  IF EXISTS (
    WITH RECURSIVE reach(id) AS (
      SELECT NEW.depends_on_task_id
      UNION
      SELECT d.depends_on_task_id
      FROM public.task_dependencies d
      JOIN reach r ON d.task_id = r.id
      WHERE d.id IS DISTINCT FROM NEW.id
    )
    SELECT 1 FROM reach WHERE id = NEW.task_id
  ) THEN
    RAISE EXCEPTION 'This dependency would create a cycle' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

-- ----------------------------------------------------------------------------
-- G-3. Timesheets: the owner may only submit (draft/rejected -> submitted).
--      Only an approver (never the owner) may approve, reject or reopen.
--      Review fields are written only by the approver.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_timesheet_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE is_approver boolean;
BEGIN
  IF public.caller_is_trusted() THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.user_id IS DISTINCT FROM auth.uid() THEN
      RAISE EXCEPTION 'You can only create your own timesheet' USING ERRCODE = '42501';
    END IF;
    IF NEW.status NOT IN ('draft', 'submitted') THEN
      RAISE EXCEPTION 'A new timesheet can only be a draft or submitted' USING ERRCODE = '42501';
    END IF;
    IF NEW.reviewed_by IS NOT NULL OR NEW.reviewed_at IS NOT NULL OR NEW.review_note IS NOT NULL THEN
      RAISE EXCEPTION 'Review fields are set by the approver' USING ERRCODE = '42501';
    END IF;
    IF NEW.status = 'submitted' THEN NEW.submitted_at := COALESCE(NEW.submitted_at, now()); END IF;
    RETURN NEW;
  END IF;

  IF NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.week_start_date IS DISTINCT FROM OLD.week_start_date THEN
    RAISE EXCEPTION 'A timesheet''s owner and week cannot be changed' USING ERRCODE = '42501';
  END IF;

  is_approver := public.user_can_approve_timesheet_of(OLD.user_id);  -- always false for one's own timesheet

  IF is_approver THEN
    IF NEW.total_hours IS DISTINCT FROM OLD.total_hours OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at THEN
      RAISE EXCEPTION 'Approvers cannot change the submitted hours' USING ERRCODE = '42501';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      IF NEW.status IN ('approved', 'rejected') AND OLD.status <> 'submitted' THEN
        RAISE EXCEPTION 'Only a submitted timesheet can be approved or rejected' USING ERRCODE = '23514';
      END IF;
      IF NEW.status = 'submitted' THEN
        RAISE EXCEPTION 'Only the employee can submit a timesheet' USING ERRCODE = '42501';
      END IF;
      NEW.reviewed_by := auth.uid();
      NEW.reviewed_at := now();
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.user_id = auth.uid() THEN
    IF NEW.reviewed_by IS DISTINCT FROM OLD.reviewed_by OR NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at
       OR NEW.review_note IS DISTINCT FROM OLD.review_note THEN
      RAISE EXCEPTION 'Review fields are set by the approver' USING ERRCODE = '42501';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      IF NOT (OLD.status IN ('draft', 'rejected') AND NEW.status = 'submitted') THEN
        RAISE EXCEPTION 'You can only submit your timesheet. Approving, rejecting and reopening are done by an approver.'
          USING ERRCODE = '42501';
      END IF;
      NEW.submitted_at := now();
    ELSIF OLD.status IN ('submitted', 'approved') THEN
      RAISE EXCEPTION 'This timesheet has been submitted and is locked' USING ERRCODE = '55006';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Not allowed to change this timesheet' USING ERRCODE = '42501';
END;
$$;
DROP TRIGGER IF EXISTS enforce_timesheet_rules ON public.timesheets;
CREATE TRIGGER enforce_timesheet_rules BEFORE INSERT OR UPDATE ON public.timesheets
  FOR EACH ROW EXECUTE FUNCTION public.enforce_timesheet_rules();

-- ----------------------------------------------------------------------------
-- G-4. Client visibility of project updates and issues: project managers only.
--      (Milestones are already manager-only for every write.)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_client_visibility() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF public.caller_is_trusted() THEN
    RETURN NEW;
  END IF;
  IF (TG_OP = 'INSERT' AND NEW.client_visible)
     OR (TG_OP = 'UPDATE' AND NEW.client_visible IS DISTINCT FROM OLD.client_visible) THEN
    IF NOT public.user_can_manage_project(NEW.project_id) THEN
      RAISE EXCEPTION 'Only a project manager can change what the client can see' USING ERRCODE = '42501';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.project_id IS DISTINCT FROM OLD.project_id THEN
    RAISE EXCEPTION 'The project cannot be changed' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS enforce_client_visibility ON public.project_updates;
CREATE TRIGGER enforce_client_visibility BEFORE INSERT OR UPDATE ON public.project_updates
  FOR EACH ROW EXECUTE FUNCTION public.enforce_client_visibility();
DROP TRIGGER IF EXISTS enforce_client_visibility ON public.project_issues;
CREATE TRIGGER enforce_client_visibility BEFORE INSERT OR UPDATE ON public.project_issues
  FOR EACH ROW EXECUTE FUNCTION public.enforce_client_visibility();

-- ----------------------------------------------------------------------------
-- G-5a. Deliverables (mirrors app/api/deliverables/**)
--   * the attached file must belong to the same project (everyone, incl. server)
--   * team members create deliverables only as draft / pending review, with no
--     approval or sharing fields; the submitter is always the caller
--   * a submitter may edit their own deliverable while draft / rejected / revised,
--     and may only move it to pending review (or rejected -> revised); sharing,
--     returning and approving are for project managers (and clients via the server)
--   * a submitter may delete their own deliverable only while it is a draft
--   The March 2026 policies below let a submitter update (e.g. approve) and delete
--   their own deliverable in any state; they are replaced by narrower ones.
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "Users can update their deliverables" ON public.deliverables;
DROP POLICY IF EXISTS "Users can create deliverables in their projects" ON public.deliverables;
DROP POLICY IF EXISTS "Users can delete their own deliverables" ON public.deliverables;
DROP POLICY IF EXISTS dl_update_submitter ON public.deliverables;
DROP POLICY IF EXISTS dl_delete_submitter ON public.deliverables;
CREATE POLICY dl_update_submitter ON public.deliverables FOR UPDATE
  USING (submitted_by = auth.uid() AND status IN ('draft', 'rejected', 'revised') AND public.user_can_contribute(project_id))
  WITH CHECK (submitted_by = auth.uid() AND status IN ('draft', 'rejected', 'revised', 'pending_review'));
CREATE POLICY dl_delete_submitter ON public.deliverables FOR DELETE
  USING (submitted_by = auth.uid() AND status = 'draft' AND public.user_can_contribute(project_id));

CREATE OR REPLACE FUNCTION public.enforce_deliverable_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.file_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.file_id IS DISTINCT FROM OLD.file_id)
     AND NOT EXISTS (SELECT 1 FROM public.project_files f WHERE f.id = NEW.file_id AND f.project_id = NEW.project_id) THEN
    RAISE EXCEPTION 'The attached file must belong to the same project' USING ERRCODE = '23514';
  END IF;
  IF public.caller_is_trusted() THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.submitted_by := auth.uid();
    IF NOT public.user_can_manage_project(NEW.project_id) THEN
      IF NEW.status NOT IN ('draft', 'pending_review') THEN
        RAISE EXCEPTION 'New deliverables start as a draft or pending review' USING ERRCODE = '42501';
      END IF;
      IF NEW.approved_by IS NOT NULL OR NEW.approved_at IS NOT NULL OR NEW.shared_at IS NOT NULL OR NEW.shared_by IS NOT NULL THEN
        RAISE EXCEPTION 'Approval and client sharing are done by a project manager' USING ERRCODE = '42501';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE
  IF NEW.project_id IS DISTINCT FROM OLD.project_id THEN
    RAISE EXCEPTION 'The project cannot be changed' USING ERRCODE = '42501';
  END IF;
  IF NOT public.user_can_manage_project(OLD.project_id) THEN
    IF NEW.approved_by IS DISTINCT FROM OLD.approved_by OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
       OR NEW.shared_at IS DISTINCT FROM OLD.shared_at OR NEW.shared_by IS DISTINCT FROM OLD.shared_by
       OR NEW.feedback IS DISTINCT FROM OLD.feedback OR NEW.submitted_by IS DISTINCT FROM OLD.submitted_by THEN
      RAISE EXCEPTION 'Approval, sharing and feedback are recorded by a project manager or the client' USING ERRCODE = '42501';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status
       AND NOT (NEW.status = 'pending_review' AND OLD.status IN ('draft', 'rejected', 'revised'))
       AND NOT (NEW.status = 'revised' AND OLD.status = 'rejected') THEN
      RAISE EXCEPTION 'You can only submit a deliverable for review. Sharing, returning and approving are done by a project manager.'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS enforce_deliverable_rules ON public.deliverables;
CREATE TRIGGER enforce_deliverable_rules BEFORE INSERT OR UPDATE ON public.deliverables
  FOR EACH ROW EXECUTE FUNCTION public.enforce_deliverable_rules();

-- ----------------------------------------------------------------------------
-- G-5b. Project files
--   * rows are created only by the server after it stores the object
--     (otherwise a user could insert a row pointing at another project's object)
--   * signed-in users may only rename (uploader or manager); only a project
--     manager may change client visibility; storage path, project, uploader,
--     size and type are fixed
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_project_file_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF public.caller_is_trusted() THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    RAISE EXCEPTION 'Files must be uploaded through the application' USING ERRCODE = '42501';
  END IF;
  IF NEW.project_id   IS DISTINCT FROM OLD.project_id
  OR NEW.storage_path IS DISTINCT FROM OLD.storage_path
  OR NEW.uploaded_by  IS DISTINCT FROM OLD.uploaded_by
  OR NEW.size_bytes   IS DISTINCT FROM OLD.size_bytes
  OR NEW.mime_type    IS DISTINCT FROM OLD.mime_type
  OR NEW.task_id      IS DISTINCT FROM OLD.task_id
  OR NEW.created_at   IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Only the file name can be changed' USING ERRCODE = '42501';
  END IF;
  IF NEW.client_visible IS DISTINCT FROM OLD.client_visible AND NOT public.user_can_manage_project(OLD.project_id) THEN
    RAISE EXCEPTION 'Only a project manager can share files with the client' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS enforce_project_file_rules ON public.project_files;
CREATE TRIGGER enforce_project_file_rules BEFORE INSERT OR UPDATE ON public.project_files
  FOR EACH ROW EXECUTE FUNCTION public.enforce_project_file_rules();

-- ----------------------------------------------------------------------------
-- G-6. Budget and hourly rate: manager-only table.
--      Readable by project managers of the project and org-wide viewers
--      (view_all_projects), writable by project managers. Never by employees
--      or clients, and never part of a projects row.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.project_financials (
  project_id uuid PRIMARY KEY REFERENCES public.projects(id) ON DELETE CASCADE,
  budget numeric(12,2) CHECK (budget IS NULL OR budget >= 0),
  hourly_rate numeric(10,2) CHECK (hourly_rate IS NULL OR hourly_rate >= 0),
  updated_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.project_financials ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pfin_select ON public.project_financials;
DROP POLICY IF EXISTS pfin_insert ON public.project_financials;
DROP POLICY IF EXISTS pfin_update ON public.project_financials;
DROP POLICY IF EXISTS pfin_delete ON public.project_financials;
CREATE POLICY pfin_select ON public.project_financials FOR SELECT
  USING (public.user_can_manage_project(project_id)
      OR (public.user_has_permission('view_all_projects') AND NOT public.user_is_client()));
CREATE POLICY pfin_insert ON public.project_financials FOR INSERT
  WITH CHECK (public.user_can_manage_project(project_id));
CREATE POLICY pfin_update ON public.project_financials FOR UPDATE
  USING (public.user_can_manage_project(project_id)) WITH CHECK (public.user_can_manage_project(project_id));
CREATE POLICY pfin_delete ON public.project_financials FOR DELETE
  USING (public.user_can_manage_project(project_id));
REVOKE ALL ON public.project_financials FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.project_financials TO authenticated;
GRANT ALL ON public.project_financials TO service_role;

-- ----------------------------------------------------------------------------
-- D-1 / D-3. Columns used by existing workflow code that never existed.
--   completed_at          set when a project is completed
--   workflow_instance_id  link written when a workflow starts. Plain column, no
--                         foreign key: a second projects<->workflow_instances
--                         relationship would make existing PostgREST joins ambiguous.
-- ----------------------------------------------------------------------------
ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS workflow_instance_id uuid;

-- D-1. Complete the project when its workflow instance completes, whoever
--      finished the last step (an employee may not have project update rights).
CREATE OR REPLACE FUNCTION public.complete_project_when_workflow_completes() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.status = 'completed' AND OLD.status IS DISTINCT FROM 'completed' AND NEW.project_id IS NOT NULL THEN
    UPDATE public.projects
       SET status = 'complete',
           completed_at = COALESCE(completed_at, NEW.completed_at, now()),
           updated_at = now()
     WHERE id = NEW.project_id
       AND status IS DISTINCT FROM 'complete';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS complete_project_when_workflow_completes ON public.workflow_instances;
CREATE TRIGGER complete_project_when_workflow_completes AFTER UPDATE OF status ON public.workflow_instances
  FOR EACH ROW EXECUTE FUNCTION public.complete_project_when_workflow_completes();
