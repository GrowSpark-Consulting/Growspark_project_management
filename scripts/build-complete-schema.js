const fs = require('fs');
const path = require('path');

const migrationsDir = path.join(__dirname, '..', 'supabase', 'migrations');
const baselineFile = path.join(migrationsDir, '20250129000000_baseline.sql');
const baselineLines = fs.readFileSync(baselineFile, 'utf8').split(/\r?\n/);

const dropTables = [
  '-- Cleanup any partial/existing tables to guarantee a clean slate without constraint conflicts',
  'DROP TABLE IF EXISTS',
  '  public.workflow_approvals,',
  '  public.user_invitations,',
  '  public.onboarding_state,',
  '  public.setup_tokens,',
  '  public.workflow_node_assignments,',
  '  public.workflow_active_steps,',
  '  public.workflow_history,',
  '  public.workflow_connections,',
  '  public.workflow_nodes,',
  '  public.workflow_instances,',
  '  public.workflow_templates,',
  '  public.client_feedback,',
  '  public.client_portal_invitations,',
  '  public.deliverables,',
  '  public.form_responses,',
  '  public.form_templates,',
  '  public.clock_sessions,',
  '  public.task_week_allocations,',
  '  public.time_entries,',
  '  public.task_dependencies,',
  '  public.tasks,',
  '  public.project_issues,',
  '  public.project_updates,',
  '  public.project_stakeholders,',
  '  public.project_assignments,',
  '  public.projects,',
  '  public.account_kanban_configs,',
  '  public.account_members,',
  '  public.accounts,',
  '  public.newsletters,',
  '  public.notifications,',
  '  public.milestones,',
  '  public.user_availability,',
  '  public.user_dashboard_preferences,',
  '  public.user_roles,',
  '  public.role_hierarchy_audit,',
  '  public.roles,',
  '  public.departments,',
  '  public.user_profiles',
  'CASCADE;'
].join('\n');

// Header (0-21) - ensure search_path is set to public, extensions
const rawHeader = baselineLines.slice(0, 22).join('\n');
const header = rawHeader.replace("SELECT pg_catalog.set_config('search_path', '', false);", "SET search_path = public, extensions, pg_catalog;");
// Functions (22-445)
const functions = baselineLines.slice(22, 446).join('\n');
// Tables (446-1049)
const tables = baselineLines.slice(446, 1050).join('\n');
// Rest (1050-end)
const rest = baselineLines.slice(1050).join('\n');

let output = '';
output += '-- ============================================================\n';
output += '-- 1. SETUP & EXTENSIONS\n';
output += '-- ============================================================\n';
output += 'CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;\n';
output += 'CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA extensions;\n';
output += header + '\n\n';
output += dropTables + '\n\n';

output += '-- ============================================================\n';
output += '-- 2. BASELINE TABLES (Tables first so functions can reference them)\n';
output += '-- ============================================================\n';
output += tables + '\n\n';

output += '-- ============================================================\n';
output += '-- 3. BASELINE FUNCTIONS (Created after tables)\n';
output += '-- ============================================================\n';
output += functions + '\n\n';

output += '-- ============================================================\n';
output += '-- 4. CONSTRAINTS, TRIGGERS, INDEXES, RLS POLICIES\n';
output += '-- ============================================================\n';
output += rest + '\n\n';

// Other migrations in alphabetical order
const otherFiles = fs.readdirSync(migrationsDir)
  .filter(f => f.endsWith('.sql') && f !== '20250129000000_baseline.sql')
  .sort();

for (const f of otherFiles) {
  output += '-- ============================================================\n';
  output += '-- Migration: ' + f + '\n';
  output += '-- ============================================================\n';
  output += fs.readFileSync(path.join(migrationsDir, f), 'utf8') + '\n\n';
}

output += '-- ============================================================\n';
output += '-- 5. SYSTEM ROLES (Required for RBAC bootstrap)\n';
output += '-- ============================================================\n';
output += [
  'INSERT INTO roles (id, name, permissions, is_system_role, hierarchy_level, description)',
  'VALUES',
  "  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Superadmin', '{}'::jsonb, TRUE, 100, 'System administrator with full access'),",
  "  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Client', '{}'::jsonb, TRUE, 0, 'Client portal user'),",
  "  ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'No Assigned Role', '{}'::jsonb, TRUE, 0, 'Default unassigned role')",
  'ON CONFLICT (id) DO NOTHING;'
].join('\n');

const targetPath = path.join(__dirname, '..', 'supabase_complete_schema.sql');
fs.writeFileSync(targetPath, output, 'utf8');
console.log('Successfully wrote reordered schema to:', targetPath, 'Size:', output.length);
