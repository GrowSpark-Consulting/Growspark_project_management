import { loadPage, settle } from '@/lib/page-data';
import { workflowsAccess } from '@/lib/page-loaders';
import { AccessDeniedPage } from '@/components/access-denied-page';
import WorkflowsClient from './workflows-client';

export const metadata = { title: 'Workflows' };

export default async function WorkflowsPage() {
  // Signed out: to the login page. Permission checked server-side (lib/page-loaders.ts).
  const { data } = settle(await loadPage('admin-workflows', workflowsAccess));

  if (!data) {
    return (
      <AccessDeniedPage
        title="Access Denied"
        description="You don't have permission to access the Workflow Builder."
        requiredPermission="MANAGE_WORKFLOWS"
      />
    );
  }

  return <WorkflowsClient canManageWorkflows={data.canManageWorkflows} />;
}
