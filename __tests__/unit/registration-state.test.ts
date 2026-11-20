import { describe, it, expect } from 'vitest'
import { decideRegistrationState, CLAIM_TIMEOUT_MS, CLOSED_MESSAGES } from '@/lib/registration-state'

const NOW = Date.parse('2026-11-20T10:00:00Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()

describe('decideRegistrationState', () => {
  it('a brand-new installation (no settings row, no users) is open', () => {
    expect(decideRegistrationState(null, 0, NOW)).toMatchObject({ open: true, reason: 'new' })
  })

  it('a registered workspace is closed and names the workspace', () => {
    const s = decideRegistrationState({ registered_at: ago(60_000), registered_by: 'u1', workspace_name: 'Acme', company_name: 'Acme Ltd' }, 1, NOW)
    expect(s).toMatchObject({ open: false, reason: 'registered', workspaceName: 'Acme' })
  })

  it('falls back to the company name when there is no workspace name', () => {
    expect(decideRegistrationState({ registered_at: ago(1), registered_by: 'u1', company_name: 'Acme Ltd' }, 1, NOW).workspaceName).toBe('Acme Ltd')
  })

  it('users but never registered (older install or test data) is closed as has_users, not "already set up"', () => {
    expect(decideRegistrationState({ registered_at: null, registered_by: null }, 9, NOW)).toMatchObject({ open: false, reason: 'has_users' })
  })

  it('a fresh claim (registration in progress) is closed', () => {
    expect(decideRegistrationState({ registered_at: ago(5_000), registered_by: null }, 0, NOW)).toMatchObject({ open: false, reason: 'in_progress' })
  })

  it('an abandoned claim with no users can be taken over', () => {
    expect(decideRegistrationState({ registered_at: ago(CLAIM_TIMEOUT_MS + 1), registered_by: null }, 0, NOW)).toMatchObject({ open: true, reason: 'abandoned' })
  })

  it('an abandoned claim with users needs an administrator', () => {
    expect(decideRegistrationState({ registered_at: ago(CLAIM_TIMEOUT_MS + 1), registered_by: null }, 1, NOW)).toMatchObject({ open: false, reason: 'incomplete' })
  })

  it('every closed reason has a message', () => {
    for (const r of ['registered', 'in_progress', 'has_users', 'incomplete'] as const) {
      expect(CLOSED_MESSAGES[r].title(null).length).toBeGreaterThan(5)
      expect(CLOSED_MESSAGES[r].body.length).toBeGreaterThan(20)
    }
  })
})
