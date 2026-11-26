'use client'

import useSWRInfinite from 'swr/infinite'

export interface FeedPage<T> {
  items: T[]
  nextCursor: string | null
  hasMore: boolean
}

/**
 * A newest-first feed loaded in chunks ("Load more"): the server returns `limit` rows after `cursor`
 * plus the cursor for the next chunk. Earlier chunks stay cached; refresh() reloads what is shown.
 *
 * @param url    the feed's address without limit/cursor (null = not ready)
 * @param select reads { items, nextCursor, hasMore } from the endpoint's response body
 */
export function useCursorFeed<T, B = unknown>(url: string | null, select: (body: B) => FeedPage<T>, fetcher: (url: string) => Promise<B>, limit = 20, options: { refreshInterval?: number } = {}) {
  const join = (base: string) => (base.includes('?') ? '&' : '?')
  const { data, error, isLoading, isValidating, size, setSize, mutate } = useSWRInfinite<FeedPage<T>>(
    (index, previous) => {
      if (!url) return null
      if (index === 0) return `${url}${join(url)}limit=${limit}`
      if (!previous?.hasMore || !previous.nextCursor) return null
      return `${url}${join(url)}limit=${limit}&cursor=${encodeURIComponent(previous.nextCursor)}`
    },
    async (key: string) => select(await fetcher(key)),
    { revalidateFirstPage: true, refreshInterval: options.refreshInterval }
  )
  const pages = data || []
  const items = pages.flatMap((p) => p.items)
  const last = pages[pages.length - 1]
  const hasMore = !!last?.hasMore
  const loadingMore = isValidating && size > pages.length
  return {
    items,
    error,
    isLoading: isLoading && !data,
    hasMore,
    loadingMore,
    loadMore: () => setSize(size + 1),
    refresh: () => mutate(),
  }
}
