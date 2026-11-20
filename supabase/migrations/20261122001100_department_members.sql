-- ============================================================================
-- Direct department membership
-- ============================================================================
-- Until now a person belonged to a department only through a role created inside
-- that department (roles.department_id). The ready-made roles (Project Manager,
-- Employee, ...) belong to no department, so people holding them were in no
-- department, and the invitation's "Department" choice had no effect.
--
-- department_members records "this person is in this department" directly, whatever
-- their role. The app counts BOTH ways (role or direct) for department visibility,
-- the sidebar, department pages and department capacity (lib/department-membership.ts).
--
-- Written by the server (service role) after its own permission check: on invitation
-- acceptance and from the Users page (PUT /api/users/[id]/departments). The policies
-- below cover direct table access.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.department_members (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  department_id uuid NOT NULL REFERENCES public.departments(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
  added_by      uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT department_members_department_id_user_id_key UNIQUE (department_id, user_id)
);

CREATE INDEX IF NOT EXISTS department_members_user_id_idx ON public.department_members (user_id);

ALTER TABLE public.department_members ENABLE ROW LEVEL SECURITY;

-- Read: your own memberships; staff (not clients) can see who is in which department
DROP POLICY IF EXISTS department_members_select ON public.department_members;
CREATE POLICY department_members_select ON public.department_members
  FOR SELECT USING (user_id = auth.uid() OR NOT public.user_is_client());

-- Add / remove: superadmin, or people who manage departments or user roles
DROP POLICY IF EXISTS department_members_insert ON public.department_members;
CREATE POLICY department_members_insert ON public.department_members
  FOR INSERT WITH CHECK (
    public.user_is_superadmin()
    OR public.user_has_permission('manage_departments'::text)
    OR public.user_has_permission('manage_user_roles'::text)
  );

DROP POLICY IF EXISTS department_members_delete ON public.department_members;
CREATE POLICY department_members_delete ON public.department_members
  FOR DELETE USING (
    public.user_is_superadmin()
    OR public.user_has_permission('manage_departments'::text)
    OR public.user_has_permission('manage_user_roles'::text)
  );
-- No UPDATE policy: change a membership by removing it and adding another.

REVOKE ALL ON public.department_members FROM anon;
REVOKE UPDATE, TRUNCATE ON public.department_members FROM authenticated;
