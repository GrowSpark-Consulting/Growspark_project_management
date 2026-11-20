import { describe, it, expect } from 'vitest'
import {
  landingPathFor, isManagerProfile, isSuperadminProfile, hasAssignedRole, isActiveProfile,
  profilePermissions, buildWhatsAppUrl,
} from '@/lib/portal'

const role = (name: string, permissions: Record<string, boolean> = {}, is_system_role = false) => ({ roles: { name, permissions, is_system_role } })
const employee = { id: 'e', user_roles: [role('Employee', { view_projects: true, manage_time: true })] }
const projectManager = { id: 'p', user_roles: [role('Project Manager', { manage_projects: true, approve_timesheets: true })] }
const teamLead = { id: 't', user_roles: [role('Team Lead', { approve_timesheets: true })] }
const superadmin = { id: 's', is_superadmin: true, user_roles: [] }
const superadminByRole = { id: 's2', user_roles: [role('Superadmin', {}, true)] }
const client = { id: 'c', is_client: true, user_roles: [role('Project Manager', { manage_projects: true })] }
const unassigned = { id: 'u', user_roles: [role('Unassigned', {}, true)] }
const noRoles = { id: 'n', user_roles: [] }

describe('landingPathFor: where each user lands after login', () => {
  it('a registered manager (superadmin) goes to the Manager portal', () => {
    expect(landingPathFor(superadmin)).toBe('/manager')
    expect(landingPathFor(superadminByRole)).toBe('/manager')
  })
  it('anyone with a manager permission goes to the Manager portal', () => {
    expect(landingPathFor(projectManager)).toBe('/manager')
    expect(landingPathFor(teamLead)).toBe('/manager')
  })
  it('an employee goes to the employee dashboard', () => {
    expect(landingPathFor(employee)).toBe('/dashboard')
  })
  it('a client always goes to the client portal, whatever roles they carry', () => {
    expect(landingPathFor(client)).toBe('/client-portal')
  })
  it('someone without a real role goes to /welcome', () => {
    expect(landingPathFor(unassigned)).toBe('/welcome')
    expect(landingPathFor(noRoles)).toBe('/welcome')
  })
  it('no profile goes to login', () => {
    expect(landingPathFor(null)).toBe('/login')
    expect(landingPathFor(undefined)).toBe('/login')
  })
})

describe('role helpers', () => {
  it('clients are never managers, even with manager permissions', () => {
    expect(isManagerProfile(client)).toBe(false)
  })
  it('the Superadmin system role counts as superadmin; a custom role named Superadmin does not', () => {
    expect(isSuperadminProfile(superadminByRole)).toBe(true)
    expect(isSuperadminProfile({ user_roles: [role('Superadmin', {}, false)] })).toBe(false)
  })
  it('a single "Unassigned" system role is not a real role', () => {
    expect(hasAssignedRole(unassigned)).toBe(false)
    expect(hasAssignedRole(employee)).toBe(true)
  })
  it('only an explicit is_active = false is inactive', () => {
    expect(isActiveProfile({ is_active: false })).toBe(false)
    expect(isActiveProfile({ is_active: true })).toBe(true)
    expect(isActiveProfile({})).toBe(true)
  })
  it('permissions are the union of true flags across roles', () => {
    const p = profilePermissions({ user_roles: [role('A', { a: true, b: false }), role('B', { c: true })] })
    expect([...p].sort()).toEqual(['a', 'c'])
  })
})

describe('buildWhatsAppUrl', () => {
  it('keeps only the digits of the phone number and encodes the message', () => {
    expect(buildWhatsAppUrl('Join us & sign in', '+91 98765-43210')).toBe('https://wa.me/919876543210?text=Join%20us%20%26%20sign%20in')
  })
  it('without a phone number, opens WhatsApp to pick a contact', () => {
    expect(buildWhatsAppUrl('Hi')).toBe('https://wa.me/?text=Hi')
  })
})
