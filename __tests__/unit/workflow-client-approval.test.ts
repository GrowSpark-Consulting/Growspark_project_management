import { describe, it, expect } from 'vitest'
import { isClientApprovalNode } from '@/lib/workflow-client-approval'

describe('isClientApprovalNode', () => {
  it('is true only for approval steps marked as a client approval', () => {
    expect(isClientApprovalNode({ node_type: 'approval', settings: { client_approval: true } })).toBe(true)
    expect(isClientApprovalNode({ node_type: 'approval', settings: { client_approval: 'true' } })).toBe(true)
    expect(isClientApprovalNode({ node_type: 'approval', settings: { client_approval: false } })).toBe(false)
    expect(isClientApprovalNode({ node_type: 'approval', settings: {} })).toBe(false)
    expect(isClientApprovalNode({ node_type: 'approval', settings: null })).toBe(false)
    expect(isClientApprovalNode({ node_type: 'role', settings: { client_approval: true } })).toBe(false)
    expect(isClientApprovalNode(null)).toBe(false)
    expect(isClientApprovalNode(undefined)).toBe(false)
  })
})
