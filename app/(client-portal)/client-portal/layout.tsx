import { redirect } from 'next/navigation';
import { loadPage, settle } from '@/lib/page-data';
import { clientPortal } from '@/lib/page-loaders';
import ClientPortalSidebar from '@/components/client-portal-sidebar';

export const metadata = {
  title: {
    default: 'Client Portal | Project Management',
    template: '%s | Client Portal | Project Management',
  },
  description: 'Project Management Client Portal - View your projects and deliverables.',
};

export default async function ClientPortalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Signed-in client users only; others are redirected (lib/page-loaders.ts)
  const { data } = settle(await loadPage('client-portal', clientPortal));
  if (!data) redirect('/login');

  return (
    <div className="flex h-screen bg-background">
      <ClientPortalSidebar
        userName={data.userName}
        userEmail={data.userEmail}
        accountName={data.accountName}
      />
      <main className="flex-1 overflow-auto">
        <div className="max-w-[1200px] mx-auto px-4 sm:px-6 lg:px-8 py-6">
          {children}
        </div>
      </main>
    </div>
  );
}
