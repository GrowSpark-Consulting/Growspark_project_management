/**
 * An approval step marked "Client approval" in the workflow editor. Only the client decides it,
 * from the client portal; internal users cannot pass it for them.
 */
export function isClientApprovalNode(node: { node_type?: unknown; settings?: unknown } | null | undefined): boolean {
  if (!node || node.node_type !== 'approval') return false;
  const value = (node.settings as { client_approval?: unknown } | null | undefined)?.client_approval;
  return value === true || value === 'true';
}
