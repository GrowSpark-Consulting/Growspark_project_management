/**
 * Can a company be registered on this installation? One answer for every caller
 * (GET/POST /api/register, the first-run check on / and /login), so the pages can
 * never disagree and bounce the visitor between /login and /signup.
 *
 * Server only (uses the service-role client). Throws RegistrationStateError when the
 * database can't be read: callers must report "unavailable", never guess.
 */

/** A claim older than this with no manager attached is treated as abandoned. */
export const CLAIM_TIMEOUT_MS = 2 * 60 * 1000

export type ClosedReason =
  | 'registered'   // a company workspace exists and has its manager
  | 'in_progress'  // someone started registering less than CLAIM_TIMEOUT_MS ago
  | 'has_users'    // users exist but no company was ever registered (older install, test data)
  | 'incomplete'   // a registration was started, never finished, and users exist: needs an admin

export type RegistrationState =
  | { open: true; reason: 'new' | 'abandoned'; workspaceName: null; claimedAt: string | null }
  | { open: false; reason: ClosedReason; workspaceName: string | null; claimedAt: string | null }

export class RegistrationStateError extends Error {}

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function getRegistrationState(admin: any, now: number = Date.now()): Promise<RegistrationState> {
  const [{ data: settings, error: sErr }, { count, error: cErr }] = await Promise.all([
    admin.from('app_settings').select('registered_at, registered_by, company_name, workspace_name').eq('id', true).maybeSingle(),
    admin.from('user_profiles').select('id', { count: 'exact', head: true }),
  ])
  if (sErr || cErr) throw new RegistrationStateError(sErr?.message || cErr?.message || 'Could not read the installation state')
  return decideRegistrationState(settings, count ?? 0, now)
}

/** Pure decision, unit-tested. */
export function decideRegistrationState(
  settings: { registered_at?: string | null; registered_by?: string | null; company_name?: string | null; workspace_name?: string | null } | null,
  users: number,
  now: number = Date.now(),
): RegistrationState {
  const workspaceName = settings?.workspace_name || settings?.company_name || null
  const claimedAt = settings?.registered_at ?? null
  if (settings?.registered_by) return { open: false, reason: 'registered', workspaceName, claimedAt }
  if (claimedAt) {
    const stale = now - new Date(claimedAt).getTime() > CLAIM_TIMEOUT_MS
    if (!stale) return { open: false, reason: 'in_progress', workspaceName, claimedAt }
    return users === 0
      ? { open: true, reason: 'abandoned', workspaceName: null, claimedAt }
      : { open: false, reason: 'incomplete', workspaceName, claimedAt }
  }
  return users === 0
    ? { open: true, reason: 'new', workspaceName: null, claimedAt: null }
    : { open: false, reason: 'has_users', workspaceName, claimedAt: null }
}

/** What the visitor is told for each closed state (shared by the API and the page). */
export const CLOSED_MESSAGES: Record<ClosedReason, { title: (name: string | null) => string; body: string }> = {
  registered: {
    title: (name) => (name ? `${name} is already set up` : 'This workspace is already set up'),
    body: 'This installation already has its company workspace. If you created it, log in with the email you registered with. Employees and clients join by invitation: ask your manager to send you an invitation link.',
  },
  in_progress: {
    title: () => 'A workspace is being created right now',
    body: 'Someone started registering this installation a moment ago. Wait a minute, then reload this page.',
  },
  has_users: {
    title: () => 'This installation already has user accounts',
    body: 'It was set up before company registration existed (for example with test data), so a new company can\'t be registered here. Log in with an existing account, or ask your administrator for an invitation.',
  },
  incomplete: {
    title: () => 'Workspace setup did not finish',
    body: 'A registration was started but never completed. An administrator needs to finish or reset it (see "Recovery" in docs/onboarding-auth-plan.md).',
  },
}
