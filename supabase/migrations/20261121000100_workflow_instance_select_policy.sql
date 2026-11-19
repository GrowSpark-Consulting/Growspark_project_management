-- ============================================================================
-- Project managers and team members can start workflows again
-- ============================================================================
-- Found by the local end-to-end run (2026-11-19): POST /api/workflows/start
-- failed with "new row violates row-level security policy for table
-- workflow_instances" for every user without an org-wide workflow permission.
--
-- The INSERT policy allowed the row, but the app inserts with RETURNING, so the
-- new row must also pass the SELECT policy. That policy relied on
-- user_can_view_workflow(id), which looks the instance up by id; inside the
-- inserting statement the new row is not visible to that lookup, so the check
-- was always false for a brand-new instance.
--
-- The SELECT policy now checks the row's own project_id / task_id with the same
-- rules as user_can_view_workflow() (team member, project creator or manager,
-- task assignee), so access to existing instances is unchanged.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.user_can_view_workflow_row(p_project_id uuid, p_task_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT (p_project_id IS NOT NULL AND public.user_can_start_project_workflow(p_project_id))
      OR (p_task_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM public.tasks t WHERE t.id = p_task_id AND t.assigned_to = auth.uid()));
$$;

COMMENT ON FUNCTION public.user_can_view_workflow_row(uuid, uuid) IS
  'Row-based workflow visibility (team member, project creator/manager, task assignee). Used by the workflow_instances SELECT policy so a new instance is visible to its creator within the inserting statement.';

REVOKE ALL ON FUNCTION public.user_can_view_workflow_row(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.user_can_view_workflow_row(uuid, uuid) TO authenticated, service_role;

DROP POLICY IF EXISTS workflow_instances_select ON public.workflow_instances;
CREATE POLICY workflow_instances_select ON public.workflow_instances
  FOR SELECT
  USING (
    public.user_is_superadmin()
    OR public.user_has_permission('view_all_workflows')
    OR public.user_has_permission('execute_any_workflow')
    OR public.user_has_permission('manage_all_workflows')
    OR public.user_can_view_workflow_row(project_id, task_id)
  );
