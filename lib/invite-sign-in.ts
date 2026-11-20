/**
 * Browser helpers for the invitation pages (/invite/[token], /client-invite/[token]).
 *
 * Accepting an invitation creates the account; these then sign THIS browser in as the new person,
 * so they land in their own portal. Before this, the person was left on "Go to Login", and if the
 * browser was still signed in as someone else (typically the manager trying the link), /login
 * sent them straight to that other person's portal.
 */
import { signInWithEmail } from '@/lib/auth'
import { createClientSupabase } from '@/lib/supabase'

/** Sign this browser out of its current account only; the account stays signed in on other devices. */
export async function signOutThisBrowser(): Promise<void> {
  const supabase = createClientSupabase()
  await supabase?.auth.signOut({ scope: 'local' }).catch(() => undefined)
}

/**
 * Sign in as the account that was just created, replacing whoever was signed in here, and confirm
 * the server sees the new session. Returns null on success, otherwise what went wrong.
 */
export async function signInAsInvitedUser(email: string, password: string): Promise<string | null> {
  const address = email.trim().toLowerCase()
  try {
    await signOutThisBrowser()
    await signInWithEmail(address, password)
    const res = await fetch('/api/profile', { cache: 'no-store' })
    const body = await res.json().catch(() => null)
    if (!res.ok || body?.profile?.email?.toLowerCase() !== address) {
      return body?.error || `the server did not receive the new session (HTTP ${res.status})`
    }
    return null
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}

/** True when the browser is signed in as someone other than the invited person. */
export function signedInAsSomeoneElse(currentEmail: string | null | undefined, invitedEmail: string | null | undefined): boolean {
  return !!currentEmail && !!invitedEmail && currentEmail.trim().toLowerCase() !== invitedEmail.trim().toLowerCase()
}
