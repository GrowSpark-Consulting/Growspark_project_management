import { Metadata } from 'next';
import { AccountsClientWrapper } from '@/components/accounts-client-wrapper';
import { loadPage, settle } from '@/lib/page-data';
import { accountsPage } from '@/lib/page-loaders';

export const metadata: Metadata = {
  title: 'Accounts',
};

export const dynamic = 'force-dynamic';

const DENIED: Record<string, { title: string; message: string }> = {
  database: { title: 'Database Error', message: 'Unable to connect to database.' },
  login: { title: 'Access Denied', message: 'Please log in to view accounts.' },
  forbidden: { title: 'Access Denied', message: "You don't have permission to view accounts." },
};

export default async function AccountsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  // One page of accounts (page, pageSize, q from the URL); access checks and data in lib/page-loaders.ts
  const sp = await searchParams;
  const query = new URLSearchParams({ page: '1' });
  for (const key of ['page', 'pageSize', 'q']) {
    const value = sp[key];
    if (typeof value === 'string' && value) query.set(key, value);
  }
  const { data, denied } = settle(await loadPage(`accounts?${query.toString()}`, () => accountsPage(query)));
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
    <div className="min-h-screen bg-background">
      <div className="space-y-4 sm:space-y-6">
        <AccountsClientWrapper
          initialAccounts={data.accounts}
          userProfile={data.userProfile}
          isAdminLevel={data.isAdminLevel}
          pagination={data.pagination}
          search={data.q || ''}
        />
      </div>
    </div>
  );
}
