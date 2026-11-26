'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import useSWR from 'swr';
import { useCursorFeed } from '@/lib/hooks/use-cursor-feed';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { jsonFetcher, apiSend, timeAgo } from '@/lib/client-api';
import { cn } from '@/lib/utils';
import { Bell, CheckCheck } from 'lucide-react';

/* eslint-disable @typescript-eslint/no-explicit-any */
export function NotificationList() {
  const router = useRouter();
  const [unreadOnly, setUnreadOnly] = useState(false);
  // Newest 20 first, older ones on "Load more" (keyset pages on the server)
  const feed = useCursorFeed<any, any>(
    `/api/notifications${unreadOnly ? '?unread=1' : ''}`,
    (body) => ({ items: body?.data || [], nextCursor: body?.meta?.nextCursor ?? null, hasMore: !!body?.meta?.hasMore }),
    jsonFetcher,
    20,
    { refreshInterval: 60000 }
  );
  // The unread count (same request the bell makes, so it is shared)
  const { data, mutate: mutateCount } = useSWR('/api/notifications?limit=10', jsonFetcher);
  const items: any[] = feed.items;
  const isLoading = feed.isLoading;
  const mutate = () => { feed.refresh(); mutateCount(); };
  const open = async (n: any) => {
    if (!n.read) { await apiSend('/api/notifications', 'POST', { ids: [n.id] }).catch(() => undefined); mutate(); }
    if (n.link) router.push(n.link);
  };
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold text-gray-900 flex items-center gap-2"><Bell className="h-7 w-7" />Notifications</h1>
          <p className="text-gray-600 mt-1">{data?.meta?.unread || 0} unread</p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant={unreadOnly ? 'default' : 'outline'} onClick={() => setUnreadOnly((v) => !v)}>Unread only</Button>
          <Button size="sm" variant="outline" onClick={async () => { await apiSend('/api/notifications', 'POST', {}); mutate(); }}><CheckCheck className="h-4 w-4 mr-1" />Mark all read</Button>
        </div>
      </div>
      <Card>
        <CardContent className="p-0">
          {isLoading ? <div className="p-4 space-y-2">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-12 w-full" />)}</div> : items.length === 0 ? (
            <p className="p-10 text-center text-gray-500">No notifications.</p>
          ) : (
            <ul className="divide-y">
              {items.map((n) => (
                <li key={n.id}>
                  <button onClick={() => open(n)} className={cn('w-full text-left p-3 hover:bg-gray-50 flex gap-3', !n.read && 'bg-blue-50/40')}>
                    <span className={cn('mt-1.5 h-2 w-2 rounded-full flex-shrink-0', n.read ? 'bg-transparent' : 'bg-blue-600')} />
                    <span className="flex-1 min-w-0">
                      <span className={cn('block text-sm', !n.read && 'font-semibold')}>{n.title}</span>
                      <span className="block text-sm text-gray-600">{n.message}</span>
                    </span>
                    <span className="text-xs text-gray-400 whitespace-nowrap">{timeAgo(n.created_at)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {feed.hasMore && (
            <div className="border-t p-3 text-center">
              <Button size="sm" variant="outline" onClick={() => feed.loadMore()} disabled={feed.loadingMore}>
                {feed.loadingMore ? 'Loading…' : 'Load more'}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
