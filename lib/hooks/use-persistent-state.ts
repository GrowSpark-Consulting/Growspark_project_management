'use client'

import { useCallback, useState, type Dispatch, type SetStateAction } from 'react'

/**
 * UI state that should survive moving to another page and back: selected tab, filters, search text,
 * page number, sort order. Kept in memory for this browser tab (a full reload or a new sign-in starts
 * fresh), so the server-rendered HTML and the first client render always agree.
 *
 * Use a key that is unique per page and per piece of state, e.g. 'projects:search'.
 */
const remembered = new Map<string, unknown>()

export function usePersistentState<T>(key: string, initial: T): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => (remembered.has(key) ? (remembered.get(key) as T) : initial))

  const set = useCallback<Dispatch<SetStateAction<T>>>(
    (next) => {
      setValue((prev) => {
        const resolved = typeof next === 'function' ? (next as (p: T) => T)(prev) : next
        remembered.set(key, resolved)
        return resolved
      })
    },
    [key]
  )

  return [value, set]
}

/** Remember / recall a value outside React state (same lifetime as usePersistentState). */
export function rememberValue(key: string, value: unknown) {
  remembered.set(key, value)
}
export function recallValue<T>(key: string): T | undefined {
  return remembered.get(key) as T | undefined
}

/** Forget every remembered value (e.g. on sign-out). */
export function clearPersistentState() {
  remembered.clear()
}
