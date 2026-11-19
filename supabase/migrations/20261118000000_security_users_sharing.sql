-- ============================================================================
-- Project Management three-portal revision — Migration 1/3
-- Security hardening (SEC-01..SEC-10), user activation, client sharing flags,
-- company settings, role templates, new permission approve_timesheets.
-- Additive and idempotent. No table or data is dropped.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. New columns needed by the policies below
-- ----------------------------------------------------------------------------
ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS deactivated_at timestamptz,
  ADD COLUMN IF NOT EXISTS phone text;

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS shared_with_client boolean NOT NULL DEFAULT true;

ALTER TABLE public.project_updates
  ADD COLUMN IF NOT EXISTS client_visible boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_project_updates_client_visible
  ON public.project_updates (project_id) WHERE client_visible;

-- D1: keep client-authored / client-decision updates visible to clients
UPDATE public.project_updates pu
SET client_visible = true
WHERE client_visible = false
  AND (
    EXISTS (SELECT 1 FROM public.user_profiles up WHERE up.id = pu.created_by AND up.is_client = true)
    OR pu.content LIKE '✅ Client approved%'
    OR pu.content LIKE '❌ Client rejected%'
  );

ALTER TABLE public.milestones
  ADD COLUMN IF NOT EXISTS project_id uuid REFERENCES public.projects(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS client_visible boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();
ALTER TABLE public.milestones DROP CONSTRAINT IF EXISTS milestones_status_check;
ALTER TABLE public.milestones ADD CONSTRAINT milestones_status_check CHECK (status IN ('pending','completed'));
CREATE INDEX IF NOT EXISTS idx_milestones_project_date ON public.milestones (project_id, date);

ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS dedupe_key text,
  ADD COLUMN IF NOT EXISTS project_id uuid REFERENCES public.projects(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX IF NOT EXISTS uq_notifications_user_dedupe
  ON public.notifications (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_notifications_user_read
  ON public.notifications (user_id, read, created_at DESC);

-- ----------------------------------------------------------------------------
-- 2. Company settings (single row)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.app_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  company_name text NOT NULL DEFAULT 'My Company',
  logo_path text,
  timezone text NOT NULL DEFAULT 'UTC',
  currency text NOT NULL DEFAULT 'USD',
  default_hourly_rate numeric(10,2) NOT NULL DEFAULT 0 CHECK (default_hourly_rate >= 0),
  week_starts_on smallint NOT NULL DEFAULT 1,
  updated_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.app_settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

-- ----------------------------------------------------------------------------
-- 3. Helper functions (SECURITY DEFINER to avoid RLS recursion)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.user_is_client() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE((SELECT is_client FROM public.user_profiles WHERE id = auth.uid()), false);
$$;

CREATE OR REPLACE FUNCTION public.user_can_view_project(pid uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT pid IS NOT NULL AND NOT public.user_is_client() AND (
       public.user_is_superadmin()
    OR public.user_has_permission('view_all_projects')
    OR public.user_has_permission('manage_all_projects')
    OR public.user_can_access_project(pid)
    OR EXISTS (SELECT 1 FROM public.projects p WHERE p.id = pid AND p.assigned_user_id = auth.uid())
    OR EXISTS (SELECT 1 FROM public.tasks t WHERE t.project_id = pid AND t.assigned_to = auth.uid())
  );
$$;

-- Team members who may write (org-wide read-only viewers excluded).
-- Redefined in migration 2 to also block archived projects.
CREATE OR REPLACE FUNCTION public.user_can_contribute(pid uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT pid IS NOT NULL AND NOT public.user_is_client() AND (
       public.user_is_superadmin()
    OR public.user_has_permission('manage_all_projects')
    OR public.user_can_access_project(pid)
    OR EXISTS (SELECT 1 FROM public.projects p WHERE p.id = pid AND p.assigned_user_id = auth.uid())
    OR EXISTS (SELECT 1 FROM public.tasks t WHERE t.project_id = pid AND t.assigned_to = auth.uid())
  );
$$;

CREATE OR REPLACE FUNCTION public.user_can_manage_project(pid uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT pid IS NOT NULL AND NOT public.user_is_client() AND (
       public.user_is_superadmin()
    OR public.user_has_permission('manage_all_projects')
    OR (public.user_has_permission('manage_projects') AND public.user_can_contribute(pid))
  );
$$;

CREATE OR REPLACE FUNCTION public.workflow_instance_project(iid uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT project_id FROM public.workflow_instances WHERE id = iid;
$$;

-- ----------------------------------------------------------------------------
-- 4. Privileged profile columns (SEC-02)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.protect_profile_privileged_columns() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  -- service role / direct SQL (no JWT user) and superadmins may change anything
  IF auth.uid() IS NULL OR COALESCE(auth.role(), '') = 'service_role' OR public.user_is_superadmin() THEN
    RETURN NEW;
  END IF;
  IF NEW.is_superadmin     IS DISTINCT FROM OLD.is_superadmin
  OR NEW.is_client         IS DISTINCT FROM OLD.is_client
  OR NEW.client_account_id IS DISTINCT FROM OLD.client_account_id
  OR NEW.email             IS DISTINCT FROM OLD.email
  OR NEW.is_active         IS DISTINCT FROM OLD.is_active
  OR NEW.deactivated_at    IS DISTINCT FROM OLD.deactivated_at THEN
    RAISE EXCEPTION 'Not allowed to change privileged profile fields' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS protect_profile_privileged_columns ON public.user_profiles;
CREATE TRIGGER protect_profile_privileged_columns
  BEFORE UPDATE ON public.user_profiles
  FOR EACH ROW EXECUTE FUNCTION public.protect_profile_privileged_columns();

-- Clients may only see their own profile row (SEC-06)
DROP POLICY IF EXISTS "user_profiles_select" ON public.user_profiles;
CREATE POLICY "user_profiles_select" ON public.user_profiles FOR SELECT
  USING (auth.uid() IS NOT NULL AND (id = auth.uid() OR NOT public.user_is_client()));

-- ----------------------------------------------------------------------------
-- 5. Remove unsafe client policies (SEC-03, SEC-04, SEC-06).
--    Clients now reach data only through /api/client/portal/* (server-checked).
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "Client users can insert workflow history" ON public.workflow_history;
DROP POLICY IF EXISTS "Client users can insert project updates" ON public.project_updates;
DROP POLICY IF EXISTS "Client users can insert project issues" ON public.project_issues;
DROP POLICY IF EXISTS client_portal_projects_select ON public.projects;
DROP POLICY IF EXISTS client_portal_updates_select ON public.project_updates;
DROP POLICY IF EXISTS client_portal_assignments_select ON public.project_assignments;
DROP POLICY IF EXISTS client_portal_workflow_instances_select ON public.workflow_instances;
DROP POLICY IF EXISTS client_portal_workflow_history_select ON public.workflow_history;
DROP POLICY IF EXISTS client_portal_workflow_nodes_select ON public.workflow_nodes;
DROP POLICY IF EXISTS client_portal_workflow_templates_select ON public.workflow_templates;
DROP POLICY IF EXISTS client_portal_accounts_select ON public.accounts;
DROP POLICY IF EXISTS client_portal_workflow_instances_update ON public.workflow_instances;
DROP POLICY IF EXISTS client_portal_active_steps_update ON public.workflow_active_steps;
DROP POLICY IF EXISTS client_portal_active_steps_insert ON public.workflow_active_steps;
DROP POLICY IF EXISTS client_portal_workflow_connections_select ON public.workflow_connections;

-- ----------------------------------------------------------------------------
-- 6. Enable RLS on the 13 unprotected tables (SEC-01)
-- ----------------------------------------------------------------------------

-- project_updates
ALTER TABLE public.project_updates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pu_select ON public.project_updates;
DROP POLICY IF EXISTS pu_insert ON public.project_updates;
DROP POLICY IF EXISTS pu_update ON public.project_updates;
DROP POLICY IF EXISTS pu_delete ON public.project_updates;
CREATE POLICY pu_select ON public.project_updates FOR SELECT USING (public.user_can_view_project(project_id));
CREATE POLICY pu_insert ON public.project_updates FOR INSERT WITH CHECK (created_by = auth.uid() AND public.user_can_contribute(project_id));
CREATE POLICY pu_update ON public.project_updates FOR UPDATE USING (created_by = auth.uid() OR public.user_can_manage_project(project_id));
CREATE POLICY pu_delete ON public.project_updates FOR DELETE USING (created_by = auth.uid() OR public.user_can_manage_project(project_id));

-- project_issues
ALTER TABLE public.project_issues ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pi_select ON public.project_issues;
DROP POLICY IF EXISTS pi_insert ON public.project_issues;
DROP POLICY IF EXISTS pi_update ON public.project_issues;
DROP POLICY IF EXISTS pi_delete ON public.project_issues;
CREATE POLICY pi_select ON public.project_issues FOR SELECT USING (public.user_can_view_project(project_id));
CREATE POLICY pi_insert ON public.project_issues FOR INSERT WITH CHECK (created_by = auth.uid() AND public.user_can_contribute(project_id));
CREATE POLICY pi_update ON public.project_issues FOR UPDATE USING (public.user_can_contribute(project_id));
CREATE POLICY pi_delete ON public.project_issues FOR DELETE USING (created_by = auth.uid() OR public.user_can_manage_project(project_id));

-- project_stakeholders
ALTER TABLE public.project_stakeholders ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ps_select ON public.project_stakeholders;
DROP POLICY IF EXISTS ps_write ON public.project_stakeholders;
CREATE POLICY ps_select ON public.project_stakeholders FOR SELECT USING (public.user_can_view_project(project_id));
CREATE POLICY ps_write ON public.project_stakeholders FOR ALL USING (public.user_can_manage_project(project_id)) WITH CHECK (public.user_can_manage_project(project_id));

-- workflow_active_steps
ALTER TABLE public.workflow_active_steps ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS was_select ON public.workflow_active_steps;
DROP POLICY IF EXISTS was_insert ON public.workflow_active_steps;
DROP POLICY IF EXISTS was_update ON public.workflow_active_steps;
DROP POLICY IF EXISTS was_delete ON public.workflow_active_steps;
CREATE POLICY was_select ON public.workflow_active_steps FOR SELECT
  USING (public.user_can_view_workflow(workflow_instance_id) OR public.user_can_view_project(public.workflow_instance_project(workflow_instance_id)));
CREATE POLICY was_insert ON public.workflow_active_steps FOR INSERT
  WITH CHECK (public.user_can_manage_workflow(workflow_instance_id) OR public.user_can_contribute(public.workflow_instance_project(workflow_instance_id)));
CREATE POLICY was_update ON public.workflow_active_steps FOR UPDATE
  USING (public.user_can_manage_workflow(workflow_instance_id) OR public.user_can_contribute(public.workflow_instance_project(workflow_instance_id)));
CREATE POLICY was_delete ON public.workflow_active_steps FOR DELETE
  USING (public.user_is_superadmin() OR public.user_has_permission('manage_workflows') OR public.user_can_manage_project(public.workflow_instance_project(workflow_instance_id)));

-- form_templates
ALTER TABLE public.form_templates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ft_select ON public.form_templates;
DROP POLICY IF EXISTS ft_write ON public.form_templates;
CREATE POLICY ft_select ON public.form_templates FOR SELECT USING (auth.uid() IS NOT NULL AND NOT public.user_is_client());
CREATE POLICY ft_write ON public.form_templates FOR ALL
  USING (public.user_is_superadmin() OR public.user_has_permission('manage_workflows'))
  WITH CHECK (public.user_is_superadmin() OR public.user_has_permission('manage_workflows'));

-- form_responses
ALTER TABLE public.form_responses ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fr_select ON public.form_responses;
DROP POLICY IF EXISTS fr_insert ON public.form_responses;
DROP POLICY IF EXISTS fr_update ON public.form_responses;
DROP POLICY IF EXISTS fr_delete ON public.form_responses;
CREATE POLICY fr_select ON public.form_responses FOR SELECT USING (auth.uid() IS NOT NULL AND NOT public.user_is_client());
CREATE POLICY fr_insert ON public.form_responses FOR INSERT WITH CHECK (auth.uid() IS NOT NULL AND NOT public.user_is_client());
CREATE POLICY fr_update ON public.form_responses FOR UPDATE USING (submitted_by = auth.uid() OR public.user_is_superadmin());
CREATE POLICY fr_delete ON public.form_responses FOR DELETE USING (public.user_is_superadmin());

-- clock_sessions
ALTER TABLE public.clock_sessions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cs_select ON public.clock_sessions;
DROP POLICY IF EXISTS cs_write ON public.clock_sessions;
CREATE POLICY cs_select ON public.clock_sessions FOR SELECT
  USING (user_id = auth.uid() OR public.user_is_superadmin() OR public.user_has_permission('view_all_time_entries'));
CREATE POLICY cs_write ON public.clock_sessions FOR ALL USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- user_availability
ALTER TABLE public.user_availability ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ua_select ON public.user_availability;
DROP POLICY IF EXISTS ua_write ON public.user_availability;
CREATE POLICY ua_select ON public.user_availability FOR SELECT USING (auth.uid() IS NOT NULL AND (user_id = auth.uid() OR NOT public.user_is_client()));
CREATE POLICY ua_write ON public.user_availability FOR ALL USING (user_id = auth.uid() OR public.user_is_superadmin()) WITH CHECK (user_id = auth.uid() OR public.user_is_superadmin());

-- milestones (global rows have project_id NULL)
ALTER TABLE public.milestones ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ms_select ON public.milestones;
DROP POLICY IF EXISTS ms_write ON public.milestones;
CREATE POLICY ms_select ON public.milestones FOR SELECT
  USING ((project_id IS NULL AND auth.uid() IS NOT NULL AND NOT public.user_is_client()) OR public.user_can_view_project(project_id));
CREATE POLICY ms_write ON public.milestones FOR ALL
  USING (public.user_is_superadmin()
      OR (project_id IS NULL AND (public.user_has_permission('manage_projects') OR public.user_has_permission('manage_accounts')))
      OR public.user_can_manage_project(project_id))
  WITH CHECK (public.user_is_superadmin()
      OR (project_id IS NULL AND (public.user_has_permission('manage_projects') OR public.user_has_permission('manage_accounts')))
      OR public.user_can_manage_project(project_id));

-- newsletters
ALTER TABLE public.newsletters ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nl_select ON public.newsletters;
DROP POLICY IF EXISTS nl_write ON public.newsletters;
CREATE POLICY nl_select ON public.newsletters FOR SELECT USING (auth.uid() IS NOT NULL AND NOT public.user_is_client());
CREATE POLICY nl_write ON public.newsletters FOR ALL USING (public.user_is_superadmin()) WITH CHECK (public.user_is_superadmin());

-- notifications (inserted by the server with the service role)
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nt_select ON public.notifications;
DROP POLICY IF EXISTS nt_update ON public.notifications;
DROP POLICY IF EXISTS nt_delete ON public.notifications;
CREATE POLICY nt_select ON public.notifications FOR SELECT USING (user_id = auth.uid());
CREATE POLICY nt_update ON public.notifications FOR UPDATE USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY nt_delete ON public.notifications FOR DELETE USING (user_id = auth.uid());

-- account_kanban_configs
ALTER TABLE public.account_kanban_configs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS akc_select ON public.account_kanban_configs;
DROP POLICY IF EXISTS akc_write ON public.account_kanban_configs;
CREATE POLICY akc_select ON public.account_kanban_configs FOR SELECT USING (auth.uid() IS NOT NULL AND NOT public.user_is_client());
CREATE POLICY akc_write ON public.account_kanban_configs FOR ALL
  USING (public.user_is_superadmin() OR public.user_has_permission('manage_projects') OR public.user_has_permission('manage_all_projects') OR public.user_has_permission('manage_accounts'))
  WITH CHECK (public.user_is_superadmin() OR public.user_has_permission('manage_projects') OR public.user_has_permission('manage_all_projects') OR public.user_has_permission('manage_accounts'));

-- role_hierarchy_audit
ALTER TABLE public.role_hierarchy_audit ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rha_select ON public.role_hierarchy_audit;
DROP POLICY IF EXISTS rha_insert ON public.role_hierarchy_audit;
CREATE POLICY rha_select ON public.role_hierarchy_audit FOR SELECT USING (public.user_is_superadmin() OR public.user_has_permission('manage_user_roles'));
CREATE POLICY rha_insert ON public.role_hierarchy_audit FOR INSERT
  WITH CHECK (public.user_is_superadmin() OR public.user_has_permission('manage_user_roles') OR public.user_has_permission('manage_departments'));

-- app_settings
ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS as_select ON public.app_settings;
DROP POLICY IF EXISTS as_write ON public.app_settings;
CREATE POLICY as_select ON public.app_settings FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY as_write ON public.app_settings FOR ALL USING (public.user_is_superadmin()) WITH CHECK (public.user_is_superadmin());

-- ----------------------------------------------------------------------------
-- 7. Fix over-broad policies on existing tables
-- ----------------------------------------------------------------------------

-- tasks: view_all_projects is read-only (SEC-08); delete = creator or manager
DROP POLICY IF EXISTS "tasks_insert" ON public.tasks;
DROP POLICY IF EXISTS "tasks_update" ON public.tasks;
DROP POLICY IF EXISTS "tasks_delete" ON public.tasks;
CREATE POLICY "tasks_insert" ON public.tasks FOR INSERT WITH CHECK (public.user_can_contribute(project_id));
CREATE POLICY "tasks_update" ON public.tasks FOR UPDATE
  USING (assigned_to = auth.uid() OR created_by = auth.uid() OR public.user_can_contribute(project_id));
CREATE POLICY "tasks_delete" ON public.tasks FOR DELETE
  USING (created_by = auth.uid() OR public.user_can_manage_project(project_id));

-- time_entries: users write only their own entries (SEC-07)
DROP POLICY IF EXISTS "time_entries_select" ON public.time_entries;
DROP POLICY IF EXISTS "time_entries_insert" ON public.time_entries;
DROP POLICY IF EXISTS "time_entries_update" ON public.time_entries;
DROP POLICY IF EXISTS "time_entries_delete" ON public.time_entries;
CREATE POLICY "time_entries_select" ON public.time_entries FOR SELECT
  USING (user_id = auth.uid() OR public.user_is_superadmin() OR public.user_has_permission('view_all_time_entries') OR public.user_can_manage_project(project_id));
CREATE POLICY "time_entries_insert" ON public.time_entries FOR INSERT
  WITH CHECK ((user_id = auth.uid() AND NOT public.user_is_client()) OR public.user_is_superadmin());
CREATE POLICY "time_entries_update" ON public.time_entries FOR UPDATE
  USING ((user_id = auth.uid() AND entry_date >= (CURRENT_DATE - INTERVAL '14 days'))
      OR public.user_is_superadmin()
      OR (public.user_has_permission('view_all_time_entries') AND public.user_has_permission('manage_time')));
CREATE POLICY "time_entries_delete" ON public.time_entries FOR DELETE
  USING ((user_id = auth.uid() AND entry_date >= (CURRENT_DATE - INTERVAL '14 days'))
      OR public.user_is_superadmin()
      OR (public.user_has_permission('view_all_time_entries') AND public.user_has_permission('manage_time')));

-- workflow_approvals: approver must be the caller (SEC-10)
DROP POLICY IF EXISTS "workflow_approvals_insert" ON public.workflow_approvals;
CREATE POLICY "workflow_approvals_insert" ON public.workflow_approvals FOR INSERT
  WITH CHECK (approver_user_id = auth.uid() AND (
    public.user_is_superadmin() OR public.user_has_permission('execute_workflows') OR public.user_has_permission('manage_all_workflows')));

-- ----------------------------------------------------------------------------
-- 8. No anonymous table access (SEC-01)
-- ----------------------------------------------------------------------------
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon;

-- ----------------------------------------------------------------------------
-- 9. Role templates (ordinary editable roles) + approve_timesheets
-- ----------------------------------------------------------------------------
INSERT INTO public.roles (name, description, permissions, is_system_role, hierarchy_level)
SELECT v.name, v.description, v.permissions::jsonb, false, v.lvl
FROM (VALUES
  ('Executive', 'Organization-wide visibility and oversight', '{"view_all_projects":true,"view_projects":true,"view_all_accounts":true,"view_accounts":true,"view_departments":true,"view_all_departments":true,"view_all_analytics":true,"view_all_account_analytics":true,"view_all_department_analytics":true,"view_all_time_entries":true,"view_all_capacity":true,"view_team_capacity":true,"manage_time":true,"edit_own_availability":true,"execute_workflows":true,"manage_user_roles":true,"manage_users":true}', 90),
  ('Project Director', 'Manages projects and teams within assigned scope', '{"manage_projects":true,"view_all_projects":true,"view_projects":true,"manage_accounts":true,"manage_users_in_accounts":true,"view_accounts":true,"view_all_accounts":true,"manage_client_invites":true,"manage_workflows":true,"execute_workflows":true,"approve_timesheets":true,"view_team_capacity":true,"view_all_department_analytics":true,"view_departments":true,"manage_user_roles":true,"manage_time":true,"edit_own_availability":true}', 80),
  ('Project Manager', 'Manages projects, tasks and employees', '{"manage_projects":true,"view_projects":true,"view_accounts":true,"manage_client_invites":true,"execute_workflows":true,"approve_timesheets":true,"view_team_capacity":true,"view_departments":true,"manage_time":true,"edit_own_availability":true}', 70),
  ('Team Lead', 'Manages team tasks and workload', '{"view_projects":true,"view_accounts":true,"execute_workflows":true,"approve_timesheets":true,"view_team_capacity":true,"view_departments":true,"manage_time":true,"edit_own_availability":true}', 60),
  ('Employee', 'Works on assigned projects and tasks', '{"view_projects":true,"view_accounts":true,"execute_workflows":true,"view_departments":true,"manage_time":true,"edit_own_availability":true}', 50)
) AS v(name, description, permissions, lvl)
WHERE NOT EXISTS (SELECT 1 FROM public.roles r WHERE lower(r.name) = lower(v.name));
