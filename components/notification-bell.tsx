'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import useSWR from 'swr';
import { Bell, CheckCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { jsonFetcher, apiSend, timeAgo } from '@/lib/client-api';
import { cn } from '@/lib/utils';

interface NotificationRow {
  id: string;
  title: string;
  message: string;
  type: string | null;
  read: boolean;
  link: string | null;
  created_at: string;
}

/** Bell with unread count. Polls every 60 s (no realtime infrastructure needed). */
export function NotificationBell({ allHref = '/notifications', className }: { allHref?: string; className?: string }) {
  const router = useRouter();
  const { data, mutate } = useSWR<{ data: NotificationRow[]; meta: { unread: number } }>(
    '/api/notifications?limit=10',
    jsonFetcher,
    { refreshInterval: 60000, revalidateOnFocus: true }
  );
  const unread = data?.meta?.unread || 0;
  const items = data?.data || [];

  const open = async (n: NotificationRow) => {
    if (!n.read) {
      await apiSend('/api/notifications', 'POST', { ids: [n.id] }).catch(() => undefined);
      mutate();
    }
    if (n.link) router.push(n.link);
  };

  const markAll = async () => {
    await apiSend('/api/notifications', 'POST', {}).catch(() => undefined);
    mutate();
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className={cn('relative h-8 w-8', className)} aria-label={`Notifications (${unread} unread)`}>
          <Bell className="h-4 w-4" />
          {unread > 0 && (
            <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 rounded-full bg-red-600 text-white text-[10px] leading-4 text-center">
              {unread > 99 ? '99+' : unread}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuLabel className="flex items-center justify-between">
          <span>Notifications</span>
          {unread > 0 && (
            <button onClick={markAll} className="text-xs text-blue-600 hover:underline flex items-center gap-1">
              <CheckCheck className="h-3 w-3" /> Mark all read
            </button>
          )}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {items.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-gray-500">You&apos;re all caught up</p>
        ) : (
          items.map((n) => (
            <DropdownMenuItem key={n.id} onClick={() => open(n)} className="flex flex-col items-start gap-0.5 cursor-pointer py-2">
              <div className="flex items-center gap-2 w-full">
                {!n.read && <span className="h-2 w-2 rounded-full bg-blue-600 flex-shrink-0" />}
                <span className={cn('text-sm truncate', !n.read && 'font-semibold')}>{n.title}</span>
                <span className="ml-auto text-[10px] text-gray-400 flex-shrink-0">{timeAgo(n.created_at)}</span>
              </div>
              <span className="text-xs text-gray-600 line-clamp-2">{n.message}</span>
            </DropdownMenuItem>
          ))
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href={allHref} className="justify-center text-sm text-blue-600 cursor-pointer">View all notifications</Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
