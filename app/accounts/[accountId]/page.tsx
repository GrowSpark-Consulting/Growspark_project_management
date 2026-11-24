import { Metadata } from 'next';
import { AccountOverview } from '@/components/account-overview';
import { loadPage, seg, settle } from '@/lib/page-data';
import { accountPage, pageTitle } from '@/lib/page-loaders';

export async function generateMetadata({ params }: { params: Promise<{ accountId: string }> }): Promise<Metadata> {
  const { accountId } = await params;
  const outcome = await loadPage(`title/account/${seg(accountId)}`, () => pageTitle('account', accountId)).catch(() => null);
  return {
    title: (outcome?.kind === 'ok' && outcome.data.title) || 'Account',
  };
}

interface AccountPageProps {
  params: Promise<{
    accountId: string;
  }>;
}

const DENIED: Record<string, { title: string; message: string }> = {
  login: { title: 'Access Denied', message: 'Please log in to view accounts.' },
  database: { title: 'Database Error', message: 'Unable to connect to database.' },
  forbidden: { title: 'Access Denied', message: "You don't have permission to view this account." },
};

export default async function AccountPage({ params }: AccountPageProps) {
  const { accountId } = await params;

  // Access checks (full or read-only) and data in lib/page-loaders.ts
  const { data, denied } = settle(await loadPage(`accounts/${seg(accountId)}`, () => accountPage(accountId)));
  if (!data) {
    const { title, message } = DENIED[denied ?? ''] ?? DENIED.forbidden;
    return (
      <div className="container mx-auto p-6">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-gray-900">{title}</h1>
          <p className="text-gray-600 mt-2">{message}</p>
        </div>
      </div>
    );
  }

  return (
    <AccountOverview
      account={data.account}
      metrics={data.metrics}
      urgentItems={data.urgentItems}
      userProfile={data.userProfile}
      hasFullAccess={data.hasFullAccess}
    />
  );
}
