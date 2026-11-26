'use client'

import { useCallback, useEffect, useMemo, useRef } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { DEFAULT_PAGE_SIZE, PAGE_SIZES } from '@/lib/pagination'
import { recallValue, rememberValue } from '@/lib/hooks/use-persistent-state'

/**
 * Page, page size, search, filters and sort of a server-paged list, kept in the URL (?page=2&q=abc) so a
 * refresh or a shared link shows the same view. Values equal to their default are left out of the URL.
 *
 * - Changing search, a filter, the sort or the page size goes back to page 1; changing the page keeps the rest.
 * - The URL is updated with the browser's history API (replaceState): no page reload, no server round trip,
 *   no extra Back-button entries.
 * - Coming back to the list without parameters (e.g. from the sidebar) restores the last view of this tab.
 * - For a list rendered on the server (its data comes with the page), pass { serverRendered: true }: the URL
 *   is then changed through the router, so the server renders the new page of data (still no full reload).
 */
export function useListParams<D extends Record<string, string>>(listId: string, defaults: D, options: { serverRendered?: boolean } = {}) {
  const pathname = usePathname()
  const router = useRouter()
  const serverRendered = !!options.serverRendered
  const searchParams = useSearchParams()
  const defaultsRef = useRef(defaults)
  const keys = useMemo(() => [...Object.keys(defaultsRef.current), 'page', 'pageSize'], [])

  const values = useMemo(() => {
    const v: Record<string, string> = { ...defaultsRef.current }
    for (const key of Object.keys(defaultsRef.current)) {
      const fromUrl = searchParams.get(key)
      if (fromUrl !== null) v[key] = fromUrl
    }
    return v as D
  }, [searchParams])

  const page = Math.max(1, Math.floor(Number(searchParams.get('page')) || 1))
  const askedSize = Number(searchParams.get('pageSize'))
  const pageSize = (PAGE_SIZES as readonly number[]).includes(askedSize) ? askedSize : DEFAULT_PAGE_SIZE

  const writeUrl = useCallback((next: URLSearchParams) => {
    const query = next.toString()
    const url = `${pathname}${query ? `?${query}` : ''}`
    if (serverRendered) router.replace(url, { scroll: false })
    // null state: Next.js then keeps useSearchParams in step with the new URL (its own state would bypass that)
    else window.history.replaceState(null, '', url)
  }, [pathname, router, serverRendered])

  // Remember this list's view; restore it when the list is opened without parameters
  const restored = useRef(false)
  useEffect(() => {
    if (!restored.current) {
      restored.current = true
      const hasOwn = keys.some((k) => searchParams.has(k))
      const last = recallValue<string>(`list:${listId}`)
      if (!hasOwn && last) {
        const next = new URLSearchParams(searchParams.toString())
        new URLSearchParams(last).forEach((v, k) => next.set(k, v))
        writeUrl(next)
        return
      }
    }
    const own = new URLSearchParams()
    keys.forEach((k) => { const v = searchParams.get(k); if (v !== null) own.set(k, v) })
    rememberValue(`list:${listId}`, own.toString())
  }, [searchParams, keys, listId, writeUrl])

  /** Set search, filters or sort (back to page 1 unless the patch sets the page itself). */
  const update = useCallback((patch: Partial<Record<keyof D | 'page' | 'pageSize', string | number>>) => {
    const next = new URLSearchParams(window.location.search)
    for (const [key, raw] of Object.entries(patch)) {
      const value = raw === undefined || raw === null ? '' : String(raw)
      const isDefault = key === 'page' ? value === '1' : key === 'pageSize' ? value === String(DEFAULT_PAGE_SIZE) : value === defaultsRef.current[key]
      if (!value || isDefault) next.delete(key)
      else next.set(key, value)
    }
    if (!('page' in patch)) next.delete('page')
    writeUrl(next)
  }, [writeUrl])

  const setPage = useCallback((p: number) => update({ page: p } as never), [update])
  const setPageSize = useCallback((size: number) => update({ pageSize: size } as never), [update])

  /** Query string for the API: the list's values plus page and pageSize. */
  const apiQuery = useMemo(() => {
    const q = new URLSearchParams()
    for (const [k, v] of Object.entries(values)) if (v) q.set(k, v)
    q.set('page', String(page))
    q.set('pageSize', String(pageSize))
    return q.toString()
  }, [values, page, pageSize])

  return { values, page, pageSize, update, setPage, setPageSize, apiQuery }
}
