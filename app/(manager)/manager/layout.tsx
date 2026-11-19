import { redirect } from 'next/navigation';
import Link from 'next/link';
import { createServerSupabase } from '@/lib/supabase-server';
import { isManagerProfile, profilePermissions } from '@/lib/portal';
import { ManagerTabs } from '@/components/manager/manager-tabs';

export const metadata = { title: { default: 'Manager', template: '%s | Manager' } };

// Server-side guard: only managers (superadmin, manage_projects, manage_all_projects,
// approve_timesheets) or org-wide viewers may open the manager portal.
export default async function ManagerLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createServerSupabase();
  if (!supabase) redirect('/login');
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login?redirectTo=/manager');
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('id, is_superadmin, is_client, is_active, user_roles!user_roles_user_id_fkey(roles!user_roles_role_id_fkey(name, is_system_role, permissions))')
    .eq('id', user.id)
    .single();
  if (!profile) redirect('/login');
  if (profile.is_client) redirect('/client-portal');
  if (profile.is_active === false) redirect('/login?error=deactivated');

  const allowed = isManagerProfile(profile as never) || profilePermissions(profile as never).has('view_all_projects');
  if (!allowed) {
    return (
      <div className="max-w-xl mx-auto mt-16 text-center space-y-3">
        <h1 className="text-2xl font-bold">Manager area</h1>
        <p className="text-gray-600">You need a manager role (manage projects or approve timesheets) to open this page.</p>
        <Link href="/dashboard" className="text-blue-600 underline">Go to My Work</Link>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <ManagerTabs />
      {children}
    </div>
  );
}
