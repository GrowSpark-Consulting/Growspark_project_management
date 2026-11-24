import { Metadata } from 'next';
import { DepartmentList } from '@/components/department-list';
import { loadPage, settle } from '@/lib/page-data';
import { departmentsPage } from '@/lib/page-loaders';

export const metadata: Metadata = {
  title: 'Departments',
};

export const dynamic = 'force-dynamic';

const DENIED: Record<string, string> = {
  login: 'Please log in to view departments.',
  forbidden: "You don't have permission to view departments.",
};

export default async function DepartmentsPage() {
  // Access checks, visible departments and their metrics in lib/page-loaders.ts
  const { data, denied } = settle(await loadPage('departments', departmentsPage));
  if (!data) {
    return (
      <div className="container mx-auto p-6">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-gray-900">Access Denied</h1>
          <p className="text-gray-600 mt-2">{DENIED[denied ?? ''] ?? DENIED.forbidden}</p>
        </div>
      </div>
    );
  }

  const { departments, departmentMetrics, canManageDepartments, userProfile } = data;
  const canCreateDepartments = canManageDepartments; // Create is part of manage

  return (
    <div className="container mx-auto p-6 space-y-6">
      {/* Header Section */}
      <div className="space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div className="space-y-2">
            <h1 className="text-3xl font-bold text-gray-900">Departments</h1>
            <p className="text-gray-600">
              Manage and view department performance across the organization
            </p>
            {canManageDepartments && (
              <p className="text-sm text-gray-500">
                You have administrative access to manage departments
              </p>
            )}
          </div>
        </div>
      </div>

      <DepartmentList
        departments={departments}
        canCreateDepartments={canCreateDepartments}
        canManageDepartments={canManageDepartments}
        userProfile={userProfile}
        initialDepartmentMetrics={departmentMetrics}
      />
    </div>
  );
}
