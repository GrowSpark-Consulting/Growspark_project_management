/**
 * The workflow progress dialog's lookups, run on the server as the signed-in user (row-level security
 * applies). Moved from components/workflow-progress-button.tsx (Phase 11) with the same logic; each
 * function returns the values the component used to set. A value left undefined means "leave as is".
 */
import { isClientApprovalNode } from './workflow-client-approval';
import { departmentMemberProfiles, profileDepartmentIds } from './department-membership';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any;
type User = { id: string; name: string; email: string };

// People who can be picked for a step: the department's members for a department step (through a role
// in it or added directly), otherwise holders of the step's role. Null when the step names nobody.
async function loadNodeUsers(db: Db, node: any): Promise<User[] | null> {
  if (!node?.entity_id) return null;
  if (node.node_type === 'department') return departmentMemberProfiles(db, node.entity_id);
  const { data: userRoles } = await db
    .from('user_roles')
    .select('user_id, users!user_roles_user_id_fkey(id, name, email)')
    .eq('role_id', node.entity_id);
  if (!userRoles) return null;
  return (userRoles as any[]).map((ur: any) => ur.users).filter((u: any) => u !== null) as User[];
}

// The node this button would progress: the given active step's node, else the current node, else the
// newest active step's node. Read from the workflow's snapshot, or the live table for older workflows.
async function loadStepNode(db: Db, instance: any, workflowInstanceId: string, activeStepId?: string | null) {
  let nodeId: string | null = instance?.current_node_id ?? null;
  if (activeStepId) {
    const { data: step } = await db.from('workflow_active_steps').select('node_id').eq('id', activeStepId).maybeSingle();
    nodeId = step?.node_id ?? nodeId;
  } else if (!nodeId) {
    const { data: steps } = await db.from('workflow_active_steps').select('node_id')
      .eq('workflow_instance_id', workflowInstanceId).eq('status', 'active')
      .order('activated_at', { ascending: false }).limit(1);
    nodeId = steps?.[0]?.node_id ?? null;
  }
  if (!nodeId) return null;
  const fromSnapshot = (instance?.started_snapshot?.nodes || []).find((n: any) => n.id === nodeId);
  if (fromSnapshot) return fromSnapshot;
  const { data: live } = await db.from('workflow_nodes').select('node_type, label, settings').eq('id', nodeId).maybeSingle();
  return live ?? null;
}

export interface ProgressAccess {
  clientApprovalStep?: string | null;
  isSuperadmin?: boolean;
  hasRequiredRole?: boolean;
  requiredRoleName?: string | null;
  isAssignedToProject?: boolean;
  isPipelineProject?: boolean;
  assignedFutureStepName?: string | null;
  currentStepName?: string | null;
}

/** Whether the user may progress the run's current (or given) step, and why not. */
export async function progressAccess(db: Db, userProfile: any, workflowInstanceId: string, externalActiveStepId?: string | null): Promise<ProgressAccess | null> {
  const out: ProgressAccess = {};
  const { data: instance, error } = await db.from('workflow_instances').select('*, started_snapshot').eq('id', workflowInstanceId).single();
  if (error || !instance) return null;

  const snapshotNodes = (instance.started_snapshot?.nodes || []) as any[];
  const hasSnapshot = snapshotNodes.length > 0;
  let currentNodeFromSnapshot = null;
  if (hasSnapshot && instance.current_node_id) currentNodeFromSnapshot = snapshotNodes.find((n: any) => n.id === instance.current_node_id);
  const instanceWithNode: any = { ...instance, workflow_nodes: currentNodeFromSnapshot };

  // A client-approval step is decided by the client in the client portal, for everyone here
  const stepNode = await loadStepNode(db, instance, workflowInstanceId, externalActiveStepId);
  out.clientApprovalStep = isClientApprovalNode(stepNode) ? String(stepNode?.label || 'This step') : null;

  const userIsSuperadmin = !!(userProfile.is_superadmin ||
    userProfile.user_roles?.some((ur: any) => ur.roles?.name?.toLowerCase() === 'superadmin'));
  out.isSuperadmin = userIsSuperadmin;
  if (userIsSuperadmin) {
    out.hasRequiredRole = true;
    out.isAssignedToProject = true;
    return out;
  }

  let nodeIdToCheck: string | null = instance.current_node_id;
  let hasNodeAssignment = false;
  let isAssignedToActiveStep = false;
  if (externalActiveStepId) {
    const { data: activeStep } = await db.from('workflow_active_steps').select('node_id, assigned_user_id').eq('id', externalActiveStepId).single();
    if (activeStep) {
      nodeIdToCheck = activeStep.node_id;
      if (activeStep.assigned_user_id === userProfile.id) isAssignedToActiveStep = true;
    }
  } else if (!nodeIdToCheck) {
    const { data: activeSteps } = await db.from('workflow_active_steps').select('node_id, assigned_user_id')
      .eq('workflow_instance_id', workflowInstanceId).eq('status', 'active')
      .order('activated_at', { ascending: false }).limit(1);
    if (activeSteps?.length) {
      nodeIdToCheck = activeSteps[0].node_id;
      if (activeSteps[0].assigned_user_id === userProfile.id) isAssignedToActiveStep = true;
    }
  }
  if (nodeIdToCheck && hasSnapshot) {
    const nodeFromSnapshot = snapshotNodes.find((n: any) => n.id === nodeIdToCheck);
    if (nodeFromSnapshot) instanceWithNode.workflow_nodes = nodeFromSnapshot;
  }

  // Assigned to the active step (e.g. sync leader), or to this node explicitly
  if (isAssignedToActiveStep) {
    hasNodeAssignment = true;
    out.hasRequiredRole = true;
    out.requiredRoleName = null;
  }
  if (!hasNodeAssignment && nodeIdToCheck) {
    const { data: nodeAssignment } = await db.from('workflow_node_assignments').select('id')
      .eq('workflow_instance_id', workflowInstanceId).eq('node_id', nodeIdToCheck).eq('user_id', userProfile.id).maybeSingle();
    if (nodeAssignment) {
      hasNodeAssignment = true;
      out.hasRequiredRole = true;
      out.requiredRoleName = null;
    }
  }

  // 1. Project assignment (project_assignments only; creator/lead do not grant progression)
  if (instance.project_id) {
    const { data: assignments } = await db.from('project_assignments').select('id')
      .eq('user_id', userProfile.id).eq('project_id', instance.project_id).is('removed_at', null);
    out.isAssignedToProject = (assignments?.length || 0) > 0;
  } else {
    out.isAssignedToProject = true;
  }
  if (hasNodeAssignment) return out;

  // 2. The step's role or department
  const currentNode = instanceWithNode.workflow_nodes;
  if (!currentNode?.entity_id) {
    out.hasRequiredRole = true;
    out.requiredRoleName = null;
    return out;
  }
  if (currentNode.node_type === 'role' || currentNode.node_type === 'approval') {
    const userRoleIds = userProfile.user_roles?.map((ur: any) => ur.role_id) || [];
    const hasRole = userRoleIds.includes(currentNode.entity_id);
    out.hasRequiredRole = hasRole;
    if (!hasRole) {
      const { data: roleData } = await db.from('roles').select('name').eq('id', currentNode.entity_id).single();
      out.requiredRoleName = roleData?.name || null;
    } else {
      out.requiredRoleName = null;
    }
  } else if (currentNode.node_type === 'department') {
    const hasAccess = profileDepartmentIds(userProfile).includes(currentNode.entity_id);
    out.hasRequiredRole = hasAccess;
    if (!hasAccess) {
      const { data: deptData } = await db.from('departments').select('name').eq('id', currentNode.entity_id).single();
      out.requiredRoleName = deptData?.name ? `${deptData.name} department` : null;
    } else {
      out.requiredRoleName = null;
    }
  } else {
    out.hasRequiredRole = true;
    out.requiredRoleName = null;
  }

  // Pipeline: the user cannot act on this step but is assigned to a later one
  const userRoleIds = userProfile.user_roles?.map((ur: any) => ur.role_id) || [];
  const hasRole = currentNode?.entity_id ? userRoleIds.includes(currentNode.entity_id) : true;
  if (!hasRole) {
    const { data: futureAssignments } = await db.from('workflow_node_assignments').select('node_id')
      .eq('workflow_instance_id', workflowInstanceId).eq('user_id', userProfile.id).neq('node_id', nodeIdToCheck || '');
    if (futureAssignments?.length) {
      const futureNodeId = futureAssignments[0].node_id;
      const futureNode = hasSnapshot ? snapshotNodes.find((n: any) => n.id === futureNodeId) : null;
      out.isPipelineProject = true;
      out.assignedFutureStepName = futureNode?.label || 'a future step';
      out.currentStepName = currentNode?.label || 'the current step';
    } else {
      out.isPipelineProject = false;
      out.assignedFutureStepName = null;
      out.currentStepName = null;
    }
  }
  return out;
}

export interface ProgressData {
  instance: any;                       // the run with its node (workflow_nodes) and template
  updatedAt: string | null;
  activeStepIdToUse: string | null;
  branchId?: string | null;            // undefined: leave as is
  isFormNode: boolean;
  existingFormData: { data: any; fields?: any[]; formName?: string } | null;
  previousFormResponses: any;          // the form's earlier answers (revision after a rejection)
  formTemplate: any | null;            // the step's form (inline or linked), null when it shows none
  nextNodes: any[];
  usersPerNode: Record<string, User[]> | null;  // several next steps: people per step
  availableUsers: User[] | null;                 // one next step: its people
  projectIssues: any[];
  parallelApprovers: any[] | null;     // null: not a parallel approval
}

/** Everything the progress dialog shows for the run's current (or given) step. */
export async function progressData(db: Db, workflowInstanceId: string, projectId: string, externalActiveStepId: string | null, branchIdState: string | null): Promise<ProgressData | null> {
  const { data: instance, error: instanceError } = await db.from('workflow_instances')
    .select('*, started_snapshot, workflow_templates(*)').eq('id', workflowInstanceId).single();
  if (instanceError || !instance) return null;

  const snapshotNodes = (instance.started_snapshot?.nodes || []) as any[];
  const snapshotConnections = (instance.started_snapshot?.connections || []) as any[];
  const hasSnapshot = snapshotNodes.length > 0 && snapshotConnections.length > 0;

  let nodeIdToLoad = instance.current_node_id;
  let activeStepIdToUse: string | null = externalActiveStepId || null;
  let branchId: string | null | undefined;
  if (externalActiveStepId) {
    const { data: activeStep } = await db.from('workflow_active_steps').select('node_id, branch_id').eq('id', externalActiveStepId).single();
    if (activeStep) { nodeIdToLoad = activeStep.node_id; branchId = activeStep.branch_id; }
  } else {
    const { data: activeSteps } = await db.from('workflow_active_steps').select('id, node_id, branch_id')
      .eq('workflow_instance_id', workflowInstanceId).eq('status', 'active')
      .order('activated_at', { ascending: false }).limit(1);
    if (activeSteps?.length) {
      nodeIdToLoad = activeSteps[0].node_id;
      activeStepIdToUse = activeSteps[0].id;
      branchId = activeSteps[0].branch_id;
    } else {
      branchId = null;
    }
  }

  // The node: snapshot first (protects running workflows from template changes), else the live table
  let currentNodeData: any = null;
  if (nodeIdToLoad) {
    if (hasSnapshot) currentNodeData = snapshotNodes.find((n: any) => n.id === nodeIdToLoad) || null;
    else currentNodeData = (await db.from('workflow_nodes').select('*').eq('id', nodeIdToLoad).single()).data;
  }

  // A form submitted earlier: shown read-only on later steps, or pre-filled on the form step after a rejection
  let existingFormData: ProgressData['existingFormData'] = null;
  let foundExistingFormData = false;
  let previousFormResponses: any = null;
  const isApprovalNode = currentNodeData?.node_type === 'approval';
  const isFormNode = currentNodeData?.node_type === 'form';
  if (nodeIdToLoad) {
    let entry: any = null;
    const { data: recentHistory } = await db.from('workflow_history')
      .select('form_response_id, notes, from_node_id, to_node_id, workflow_nodes!workflow_history_from_node_id_fkey(node_type, label)')
      .eq('workflow_instance_id', workflowInstanceId).order('created_at', { ascending: false }).limit(10);
    const hasForm = (e: any) => e.form_response_id || (e.notes && String(e.notes).includes('inline_form'));
    if (isApprovalNode) {
      entry = (recentHistory as any[])?.find((e: any) => e.to_node_id === nodeIdToLoad && hasForm(e));
      if (!entry) entry = (recentHistory as any[])?.find((e: any) => e.workflow_nodes?.node_type === 'form' && hasForm(e));
    }
    if (!entry && isFormNode) entry = (recentHistory as any[])?.find((e: any) => e.from_node_id === nodeIdToLoad && hasForm(e));
    if (entry) {
      if (entry.form_response_id) {
        const { data: formResponse } = await db.from('form_responses')
          .select('response_data, form_template:form_templates(fields, name)').eq('id', entry.form_response_id).single();
        if (formResponse) {
          if (isFormNode) previousFormResponses = formResponse.response_data;
          else {
            existingFormData = { data: formResponse.response_data, fields: formResponse.form_template?.fields, formName: formResponse.form_template?.name };
            foundExistingFormData = true;
          }
        }
      } else if (entry.notes) {
        try {
          const notes = JSON.parse(entry.notes);
          if (notes.type === 'inline_form' && notes.data) {
            if (isFormNode) previousFormResponses = notes.data.responses || {};
            else {
              existingFormData = { data: notes.data.responses || {}, fields: notes.data.fields, formName: notes.data.formName };
              foundExistingFormData = true;
            }
          }
        } catch { /* notes that are not JSON are ignored */ }
      }
    }
  }

  // The step's editable form: none on approval steps or after a form was submitted (except the form
  // step itself); else the inline form from the node settings, else the linked form template
  let formTemplate: any = null;
  if (isApprovalNode || (foundExistingFormData && !isFormNode)) {
    formTemplate = null;
  } else if (currentNodeData?.settings?.formFields?.length > 0) {
    formTemplate = {
      id: `inline-${currentNodeData.id}`,
      name: currentNodeData.settings.formName || currentNodeData.label || 'Form',
      description: currentNodeData.settings.formDescription || null,
      fields: (currentNodeData.settings.formFields as any[]).map((field: any) => ({
        id: field.id,
        type: field.type === 'select' ? 'dropdown' : field.type,
        label: field.label,
        required: field.required || false,
        placeholder: field.placeholder || '',
        options: field.options || [],
        defaultValue: field.defaultValue,
        validation: field.validation,
        conditional: field.conditional,
      })),
    };
  } else if (currentNodeData?.form_template_id) {
    const { data: template, error: templateError } = await db.from('form_templates').select('*').eq('id', currentNodeData.form_template_id).single();
    if (template && !templateError) formTemplate = template;
  }

  // The next step(s) and the people who can be picked for them
  let nextNodes: any[] = [];
  let usersPerNode: Record<string, User[]> | null = null;
  let availableUsers: User[] | null = null;
  const nodeIdForConnections = nodeIdToLoad || instance.current_node_id;
  if (nodeIdForConnections) {
    let connections: any[] = [];
    if (hasSnapshot) connections = snapshotConnections.filter((c: any) => c.from_node_id === nodeIdForConnections);
    else connections = (await db.from('workflow_connections').select('to_node_id, condition')
      .eq('workflow_template_id', instance.workflow_template_id).eq('from_node_id', nodeIdForConnections)).data || [];
    if (connections.length) {
      const nextNodeIds = connections.filter((c: any) => !c.condition?.decision && !c.condition?.conditionValue).map((c: any) => c.to_node_id);
      nextNodes = hasSnapshot
        ? snapshotNodes.filter((n: any) => nextNodeIds.includes(n.id))
        : (await db.from('workflow_nodes').select('*').in('id', nextNodeIds)).data || [];
      if (nextNodes.length > 1) {
        usersPerNode = {};
        for (const node of nextNodes) {
          const users = await loadNodeUsers(db, node);
          if (users) usersPerNode[node.id] = users;
        }
      } else if (nextNodes.length === 1) {
        availableUsers = await loadNodeUsers(db, nextNodes[0]);
      }
    }
  }

  // Open project issues, to inform the decision
  const { data: issues } = await db.from('project_issues').select('id, content, status, created_at')
    .eq('project_id', projectId).eq('status', 'open').order('created_at', { ascending: false }).limit(5);

  // Others approving in parallel branches of the same fork
  let parallelApprovers: any[] | null = null;
  const currentStepBranchId = branchIdState || 'main';
  if (currentNodeData?.node_type === 'approval' && currentStepBranchId !== 'main') {
    const [branchPrefix, flowId] = currentStepBranchId.split('_');
    if (branchPrefix && flowId) {
      const baseBranch = branchPrefix.match(/^(.+)-\d+$/)?.[1] ?? branchPrefix;
      const { data: siblingSteps } = await db.from('workflow_active_steps')
        .select('id, node_id, branch_id, status, assigned_user_id, workflow_nodes!inner(id, label, node_type)')
        .eq('workflow_instance_id', workflowInstanceId).neq('id', activeStepIdToUse || '')
        .in('status', ['active', 'completed', 'waiting']);
      const siblings = ((siblingSteps as any[]) || []).filter((step: any) => {
        const [stepPrefix, stepFlowId] = String(step.branch_id).split('_');
        if (stepFlowId !== flowId) return false;
        const stepBase = stepPrefix.match(/^(.+)-\d+$/)?.[1] ?? stepPrefix;
        return stepBase === baseBranch && stepPrefix !== branchPrefix;
      });
      if (siblings.length) {
        parallelApprovers = await Promise.all(siblings.map(async (step: any) => {
          let userName = 'Unassigned';
          if (step.assigned_user_id) {
            const { data: userData } = await db.from('user_profiles').select('name').eq('id', step.assigned_user_id).maybeSingle();
            userName = userData?.name || 'Unknown User';
          }
          const { data: approval } = await db.from('workflow_approvals').select('decision')
            .eq('workflow_instance_id', workflowInstanceId).eq('node_id', step.node_id)
            .order('created_at', { ascending: false }).limit(1).maybeSingle();
          return { id: step.id, userName, nodeName: step.workflow_nodes?.label || 'Unknown', completed: step.status === 'completed', decision: approval?.decision || null };
        }));
      }
    }
  }

  return {
    instance: { ...instance, workflow_nodes: currentNodeData },
    updatedAt: instance.updated_at ?? null,
    activeStepIdToUse,
    branchId,
    isFormNode,
    existingFormData,
    previousFormResponses,
    formTemplate,
    nextNodes,
    usersPerNode,
    availableUsers,
    projectIssues: issues || [],
    parallelApprovers,
  };
}
