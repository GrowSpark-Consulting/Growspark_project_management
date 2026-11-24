import { redirect } from 'next/navigation';
import DepartmentAdminTabs from '@/components/department-admin-tabs';
import { loadPage, seg, settle } from '@/lib/page-data';
import { departmentAdminPage } from '@/lib/page-loaders';

interface DepartmentAdminPageProps {
  params: Promise<{
    departmentId: string;
  }>;
}

export default async function DepartmentAdminPage({ params }: DepartmentAdminPageProps) {
  // Await params for Next.js 15 compatibility
  const { departmentId } = await params;

  // Admin-level users only; others are redirected (lib/page-loaders.ts)
  const { data } = settle(await loadPage(`departments/${seg(departmentId)}/admin`, () => departmentAdminPage(departmentId)));
  if (!data) redirect('/departments');

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <h1 className="text-3xl font-bold">{data.departmentName} Administration</h1>
        <p className="text-muted-foreground">
          Manage roles, team settings, and department configuration
        </p>
      </div>

      <DepartmentAdminTabs departmentId={departmentId} />
    </div>
  );
}
