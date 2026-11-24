import Link from 'next/link';
import { loadPage, settle } from '@/lib/page-data';
import { managerAccess } from '@/lib/page-loaders';
import { ManagerTabs } from '@/components/manager/manager-tabs';

export const metadata = { title: { default: 'Manager', template: '%s | Manager' } };

// Server-side guard: only managers (superadmin, manage_projects, manage_all_projects,
// approve_timesheets) or org-wide viewers may open the manager portal.
export default async function ManagerLayout({ children }: { children: React.ReactNode }) {
  const { data } = settle(await loadPage('manager', managerAccess));
  if (!data?.allowed) {
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
