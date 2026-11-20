import { describe, it, expect } from 'vitest'
import { profileDepartmentIds, profileDepartments, departmentMemberIds, loadDirectMemberships } from '@/lib/department-membership'
import { managesDepartment } from '@/lib/permission-checker'

const TECH = { id: 'd-tech', name: 'Tech' }
const HR = { id: 'd-hr', name: 'HR' }
const roleIn = (d: { id: string; name: string } | null) => ({ roles: { department_id: d?.id ?? null, departments: d } })

describe('department membership from a loaded profile', () => {
  it('a company-wide role (no department) and no direct membership → no departments', () => {
    const p = { user_roles: [roleIn(null)], department_members: [] }
    expect(profileDepartmentIds(p)).toEqual([])
    expect(profileDepartments(p)).toEqual([])
  })
  it('added directly → in the department, whatever the role', () => {
    const p = { user_roles: [roleIn(null)], department_members: [{ department_id: TECH.id, departments: TECH }] }
    expect(profileDepartmentIds(p)).toEqual([TECH.id])
    expect(profileDepartments(p)).toEqual([TECH])
  })
  it('role-based and direct memberships combine without duplicates, sorted by name', () => {
    const p = { user_roles: [roleIn(TECH)], department_members: [{ department_id: TECH.id, departments: TECH }, { department_id: HR.id, departments: HR }] }
    expect(profileDepartmentIds(p).sort()).toEqual([HR.id, TECH.id].sort())
    expect(profileDepartments(p)).toEqual([HR, TECH])
  })
  it('profiles loaded without department_members still work (role-based only)', () => {
    expect(profileDepartmentIds({ user_roles: [roleIn(HR)] })).toEqual([HR.id])
    expect(profileDepartmentIds(null)).toEqual([])
  })
  it('managesDepartment (the department access check) counts direct membership', async () => {
    const p = { id: 'u', user_roles: [roleIn(null)], department_members: [{ department_id: TECH.id }] }
    expect(await managesDepartment(p as never, TECH.id)).toBe(true)
    expect(await managesDepartment(p as never, HR.id)).toBe(false)
  })
})

/** Minimal Supabase stand-in answering the three queries departmentMemberIds makes. */
function fakeDb(tables: Record<string, any[]>, failing: string[] = []) {
  return {
    from(table: string) {
      const filters: Array<(r: any) => boolean> = []
      const q: any = {
        select: () => q,
        eq: (col: string, v: any) => { filters.push((r) => r[col] === v); return q },
        in: (col: string, vs: any[]) => { filters.push((r) => vs.includes(r[col])); return q },
        then: (resolve: any) => resolve(failing.includes(table)
          ? { data: null, error: { message: 'relation does not exist' } }
          : { data: (tables[table] || []).filter((r) => filters.every((f) => f(r))), error: null }),
      }
      return q
    },
  }
}

describe('departmentMemberIds: everyone in a department', () => {
  const db = {
    roles: [{ id: 'r-tech', department_id: TECH.id }, { id: 'r-pm', department_id: null }],
    user_roles: [{ user_id: 'via-role', role_id: 'r-tech' }, { user_id: 'pm', role_id: 'r-pm' }],
    department_members: [{ user_id: 'pm', department_id: TECH.id }, { user_id: 'other', department_id: HR.id }],
  }
  it('combines people with a department role and people added directly', async () => {
    expect((await departmentMemberIds(fakeDb(db), TECH.id)).sort()).toEqual(['pm', 'via-role'])
  })
  it('still returns role-based members if department_members is missing', async () => {
    expect(await departmentMemberIds(fakeDb(db, ['department_members']), TECH.id)).toEqual(['via-role'])
  })
  it('loadDirectMemberships never throws and returns [] on error', async () => {
    expect(await loadDirectMemberships(fakeDb(db, ['department_members']), 'pm')).toEqual([])
  })
})
