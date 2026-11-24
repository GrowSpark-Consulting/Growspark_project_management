import { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { DepartmentOverview } from '@/components/department-overview';
import { loadPage, seg, settle } from '@/lib/page-data';
import { departmentPage, pageTitle } from '@/lib/page-loaders';

export async function generateMetadata({ params }: { params: Promise<{ departmentId: string }> }): Promise<Metadata> {
  const { departmentId } = await params;
  const outcome = await loadPage(`title/department/${seg(departmentId)}`, () => pageTitle('department', departmentId)).catch(() => null);
  return {
    title: (outcome?.kind === 'ok' && outcome.data.title) || 'Department',
  };
}

interface DepartmentPageProps {
  params: Promise<{
    departmentId: string;
  }>;
}

export default async function DepartmentPage({ params }: DepartmentPageProps) {
  const { departmentId } = await params;

  // Access checks and data in lib/page-loaders.ts (no access or no department: not found)
  const { data } = settle(await loadPage(`departments/${seg(departmentId)}`, () => departmentPage(departmentId)));
  if (!data) notFound();

  return (
    <div className="space-y-6">
      <DepartmentOverview
        department={data.department}
        metrics={data.metrics}
        projects={data.projects}
        canManageDepartments={data.canManageDepartments}
        userProfile={data.userProfile}
      />
    </div>
  );
}
