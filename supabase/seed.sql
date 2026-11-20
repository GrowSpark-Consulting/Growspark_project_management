-- Project Management Clean Seed
-- Platform starts empty. First user creates superadmin via /onboarding.

BEGIN;

-- ============================================================================
-- CLEANUP: Truncate all tables (preserves structure, clean slate)
-- ============================================================================

TRUNCATE
  setup_tokens,
  onboarding_state,
  user_invitations,
  workflow_active_steps,
  workflow_node_assignments,
  client_feedback,
  client_portal_invitations,
  form_responses,
  workflow_history,
  workflow_instances,
  workflow_connections,
  workflow_nodes,
  workflow_templates,
  form_templates,
  clock_sessions,
  task_week_allocations,
  time_entries,
  user_availability,
  user_dashboard_preferences,
  account_members,
  project_assignments,
  role_hierarchy_audit,
  newsletters,
  project_issues,
  project_updates,
  project_stakeholders,
  account_kanban_configs,
  notifications,
  deliverables,
  task_dependencies,
  tasks,
  projects,
  accounts,
  user_roles,
  user_profiles,
  roles,
  departments,
  milestones
CASCADE;

-- ============================================================================
-- SYSTEM ROLES ONLY (required for RBAC bootstrap)
-- ============================================================================

INSERT INTO roles (id, name, permissions, is_system_role, hierarchy_level, description)
VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Superadmin', '{}'::jsonb, TRUE, 100, 'System administrator with full access'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Client', '{}'::jsonb, TRUE, 0, 'Client portal user'),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'No Assigned Role', '{}'::jsonb, TRUE, 0, 'Default unassigned role')
ON CONFLICT (id) DO NOTHING;

-- The company settings row (one per installation). TRUNCATE user_profiles CASCADE above also
-- empties app_settings, which references users, so it is re-created here.
INSERT INTO app_settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

-- ============================================================================
-- ROLE TEMPLATES (ordinary, editable roles)
-- Migration 20261118000000 inserts these, but the TRUNCATE above removes them
-- on every local `supabase db reset`, so they are re-inserted here. Keep this
-- list identical to section 9 of that migration.
-- ============================================================================

INSERT INTO roles (name, description, permissions, is_system_role, hierarchy_level)
SELECT v.name, v.description, v.permissions::jsonb, FALSE, v.lvl
FROM (VALUES
  ('Executive', 'Organization-wide visibility and oversight', '{"view_all_projects":true,"view_projects":true,"view_all_accounts":true,"view_accounts":true,"view_departments":true,"view_all_departments":true,"view_all_analytics":true,"view_all_account_analytics":true,"view_all_department_analytics":true,"view_all_time_entries":true,"view_all_capacity":true,"view_team_capacity":true,"manage_time":true,"edit_own_availability":true,"execute_workflows":true,"manage_user_roles":true,"manage_users":true}', 90),
  ('Project Director', 'Manages projects and teams within assigned scope', '{"manage_projects":true,"view_all_projects":true,"view_projects":true,"manage_accounts":true,"manage_users_in_accounts":true,"view_accounts":true,"view_all_accounts":true,"manage_client_invites":true,"manage_workflows":true,"execute_workflows":true,"approve_timesheets":true,"view_team_capacity":true,"view_all_department_analytics":true,"view_departments":true,"manage_user_roles":true,"manage_time":true,"edit_own_availability":true}', 80),
  ('Project Manager', 'Manages projects, tasks and employees', '{"manage_projects":true,"view_projects":true,"view_accounts":true,"manage_client_invites":true,"execute_workflows":true,"approve_timesheets":true,"view_team_capacity":true,"view_departments":true,"manage_time":true,"edit_own_availability":true}', 70),
  ('Team Lead', 'Manages team tasks and workload', '{"view_projects":true,"view_accounts":true,"execute_workflows":true,"approve_timesheets":true,"view_team_capacity":true,"view_departments":true,"manage_time":true,"edit_own_availability":true}', 60),
  ('Employee', 'Works on assigned projects and tasks', '{"view_projects":true,"view_accounts":true,"execute_workflows":true,"view_departments":true,"manage_time":true,"edit_own_availability":true}', 50)
) AS v(name, description, permissions, lvl)
WHERE NOT EXISTS (SELECT 1 FROM roles r WHERE lower(r.name) = lower(v.name));

COMMIT;
