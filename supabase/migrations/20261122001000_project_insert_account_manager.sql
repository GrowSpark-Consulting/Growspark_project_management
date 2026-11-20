-- ============================================================================
-- Account managers with "manage projects" can create projects in their account
-- ============================================================================
-- projects_insert (baseline) allowed: superadmin, manage_all_projects, or
-- manage_projects AND a row in account_members. It ignored the account's manager
-- (accounts.account_manager_id), which is what creating an account makes you
-- (POST /api/accounts sets it to the creator). The app's own check
-- (lib/permission-checker.ts hasAccountAccess) and the projects SELECT policy both
-- count the account manager, so a Project Director who added a client account and
-- then created its first project was refused by the database (42501), both from the
-- "Create New Project" dialog and from POST /api/projects.
--
-- Adds that one case; everything else is unchanged. Still requires manage_projects.
-- ============================================================================

DROP POLICY IF EXISTS "projects_insert" ON public.projects;
CREATE POLICY "projects_insert" ON public.projects FOR INSERT WITH CHECK (
  public.user_is_superadmin()
  OR public.user_has_permission('manage_all_projects'::text)
  OR (
    public.user_has_permission('manage_projects'::text)
    AND (
      EXISTS (SELECT 1 FROM public.account_members am WHERE am.account_id = projects.account_id AND am.user_id = auth.uid())
      OR public.user_is_account_manager(projects.account_id)
    )
  )
);
