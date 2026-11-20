/**
 * Manager onboarding checklist. "Done" is read from real data, so a step completed anywhere in the
 * app (not only from the checklist) counts. Skipped steps and "hide checklist" are stored on
 * app_settings.onboarding: { skipped: string[], dismissed?: boolean, settingsSaved?: boolean }.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any;

export const ONBOARDING_STEPS = [
  { key: 'company', title: 'Complete your company profile', description: 'Company name, workspace name and URL, phone and logo.', href: '/admin/settings', optional: false },
  { key: 'settings', title: 'Configure workspace settings', description: 'Time zone, currency and the default hourly rate.', href: '/admin/settings', optional: true },
  { key: 'departments', title: 'Add departments', description: 'Group your people, for example Design, Development, Marketing.', href: '/departments', optional: true },
  { key: 'employees', title: 'Invite employees', description: 'Send invitation links by WhatsApp or email with their role.', href: '/admin/invitations', optional: false },
  { key: 'clients', title: 'Invite clients', description: 'Create a client account and invite its members to the client portal.', href: '/admin/client-portal', optional: true },
  { key: 'project', title: 'Create your first project', description: 'Or start one from a template.', href: '/projects', optional: false },
  { key: 'team', title: 'Assign the project team', description: 'Add employees to the project so they can see and work on it.', href: '/projects', optional: false },
] as const;
export type OnboardingKey = (typeof ONBOARDING_STEPS)[number]['key'];

export async function onboardingStatus(admin: Db) {
  const [settings, depts, invites, internalUsers, clientInvites, clients, projects, teams] = await Promise.all([
    admin.from('app_settings').select('company_name, workspace_name, workspace_slug, company_phone, onboarding').eq('id', true).maybeSingle(),
    admin.from('departments').select('id', { count: 'exact', head: true }),
    admin.from('user_invitations').select('id', { count: 'exact', head: true }),
    admin.from('user_profiles').select('id', { count: 'exact', head: true }).eq('is_client', false),
    admin.from('client_portal_invitations').select('id', { count: 'exact', head: true }),
    admin.from('user_profiles').select('id', { count: 'exact', head: true }).eq('is_client', true),
    admin.from('projects').select('id', { count: 'exact', head: true }),
    admin.from('project_assignments').select('project_id, user_id').is('removed_at', null).limit(2000),
  ]);
  const s = settings.data || {};
  const state = (s.onboarding || {}) as { skipped?: string[]; dismissed?: boolean; settingsSaved?: boolean };
  const membersPerProject = new Map<string, number>();
  for (const a of teams.data || []) membersPerProject.set(a.project_id, (membersPerProject.get(a.project_id) || 0) + 1);

  const done: Record<OnboardingKey, boolean> = {
    company: !!(s.company_name && s.workspace_name && s.workspace_slug && s.company_phone),
    settings: !!state.settingsSaved,
    departments: (depts.count || 0) > 0,
    employees: (invites.count || 0) > 0 || (internalUsers.count || 0) > 1,
    clients: (clientInvites.count || 0) > 0 || (clients.count || 0) > 0,
    project: (projects.count || 0) > 0,
    team: [...membersPerProject.values()].some((n) => n >= 2),
  };
  const skipped = new Set(state.skipped || []);
  const steps = ONBOARDING_STEPS.map((st) => ({ ...st, done: done[st.key], skipped: !done[st.key] && skipped.has(st.key) }));
  const finished = steps.every((st) => st.done || st.skipped);
  return { steps, completed: steps.filter((st) => st.done).length, total: steps.length, finished, dismissed: !!state.dismissed };
}

export async function updateOnboarding(admin: Db, change: (state: { skipped: string[]; dismissed?: boolean; settingsSaved?: boolean }) => void) {
  const { data } = await admin.from('app_settings').select('onboarding').eq('id', true).maybeSingle();
  const state = { skipped: [] as string[], ...(data?.onboarding || {}) };
  change(state);
  state.skipped = Array.from(new Set(state.skipped));
  await admin.from('app_settings').update({ onboarding: state }).eq('id', true);
}
