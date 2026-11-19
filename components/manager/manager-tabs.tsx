'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import useSWR from 'swr';
import { jsonFetcher } from '@/lib/client-api';
import { cn } from '@/lib/utils';

const TABS = [
  { href: '/manager', label: 'Overview' },
  { href: '/manager/team', label: 'Team' },
  { href: '/manager/timesheets', label: 'Timesheets' },
  { href: '/manager/approvals', label: 'Approvals' },
  { href: '/manager/reports', label: 'Reports' },
  { href: '/manager/templates', label: 'Templates' },
];

export function ManagerTabs() {
  const pathname = usePathname();
  const { data } = useSWR('/api/manager/approvals', jsonFetcher, { refreshInterval: 120000 });
  const a = data?.data;
  const pending = a ? a.tasks.length + a.timesheets.length + a.deliverables.length + (a.workflowSteps?.length || 0) : 0;
  return (
    <nav className="flex flex-wrap gap-1 border-b">
      {TABS.map((t) => {
        const active = t.href === '/manager' ? pathname === '/manager' : pathname.startsWith(t.href);
        return (
          <Link key={t.href} href={t.href}
            className={cn('px-3 py-2 text-sm -mb-px border-b-2', active ? 'border-blue-600 text-blue-700 font-medium' : 'border-transparent text-gray-600 hover:text-gray-900')}>
            {t.label}
            {t.href === '/manager/approvals' && pending > 0 && <span className="ml-1.5 rounded-full bg-red-600 text-white text-[10px] px-1.5">{pending}</span>}
          </Link>
        );
      })}
    </nav>
  );
}
