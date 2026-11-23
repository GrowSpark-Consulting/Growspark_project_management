import { z } from 'zod';
import { api, ok, assertUuid, HttpError } from '@/lib/api/context';
import { uuidSchema } from '@/lib/validation-schemas';
import { accountService } from '@/lib/account-service';
import { taskServiceDB } from '@/lib/task-service-db';

// GET /api/projects/[projectId]/page-data: the project page's lookups (moved off browser queries).
// Each view runs what the page used to run in the browser, as the signed-in user, so row-level
// security applies.
//   view=overview       the project with account, lead, stakeholders, departments, the active workflow
//                       run and its current step name(s), and whether the user may edit the project
//   view=status         status, completed_at, workflow_instance_id
//   view=workflow-step  &instanceId=  the run's current step (label, node type) and status
//   view=tasks          the project's tasks (logged hours summed from time entries) and the hours
//                       logged to the project without a task
//   view=latest-run     the newest active or completed workflow run
//   view=contributors   people who worked on the project's workflow
//   view=people         everyone's id, name and email (for adding team members)
//   view=form-data      &instanceId=  forms submitted during the workflow run
const query = z.object({
  view: z.enum(['overview', 'status', 'workflow-step', 'tasks', 'latest-run', 'contributors', 'people', 'form-data']),
  instanceId: uuidSchema.optional(),
});

/* eslint-disable @typescript-eslint/no-explicit-any */
const one = (v: any) => (Array.isArray(v) ? v[0] : v);

function addDepartments(target: any[], userRoles: any[] | null) {
  for (const ur of userRoles || []) {
    const dept = one(one(ur.roles)?.departments);
    if (dept && !target.some((d) => d.id === dept.id)) target.push(dept);
  }
}

async function overview(db: any, projectId: string, userId: string) {
  const { data, error } = await db.from('projects').select('*, account:accounts(*)').eq('id', projectId).maybeSingle();
  if (error) throw new HttpError(500, 'Failed to load project');
  if (!data) throw new HttpError(404, 'Project not found or access denied');

  const [lead, stakeholders, assignments] = await Promise.all([
    data.assigned_user_id ? db.from('user_profiles').select('*').eq('id', data.assigned_user_id).single() : Promise.resolve({ data: null }),
    db.rpc('get_project_stakeholders', { project_uuid: projectId }),
    db.from('project_assignments').select('user_id').eq('project_id', projectId).is('removed_at', null),
  ]);
  const stakeholderRows = (stakeholders.data || []).map((row: any) => ({
    id: row.id, user_id: row.user_id, role: row.role,
    user_profiles: { id: row.user_id, name: row.user_name, email: row.user_email, image: row.user_image },
  }));

  const ROLE_DEPTS = 'role_id, roles!user_roles_role_id_fkey ( department_id, departments!roles_department_id_fkey ( id, name ) )';
  const departments: any[] = [];
  if (data.assigned_user_id) addDepartments(departments, (await db.from('user_roles').select(ROLE_DEPTS).eq('user_id', data.assigned_user_id)).data);
  const memberIds = (assignments.data || []).map((a: any) => a.user_id).filter(Boolean);
  if (memberIds.length) addDepartments(departments, (await db.from('user_roles').select(`user_id, ${ROLE_DEPTS}`).in('user_id', memberIds)).data);

  // The active workflow run (projects.workflow_instance_id can point at a finished one)
  let workflowInstanceId: string | null = null;
  const active = await db.from('workflow_instances').select('id').eq('project_id', projectId).eq('status', 'active').order('started_at', { ascending: false }).limit(1);
  if (!active.error && active.data?.length) workflowInstanceId = active.data[0].id;
  else if (data.workflow_instance_id) {
    const stored = await db.from('workflow_instances').select('id, status').eq('id', data.workflow_instance_id).single();
    if (stored.data?.status === 'active') workflowInstanceId = stored.data.id;
  }

  // Current step name(s): parallel steps first, then the run's current step; snapshot labels first
  let stepNames: string[] | null = null;
  if (workflowInstanceId) {
    const { data: instance } = await db.from('workflow_instances').select('current_node_id, started_snapshot').eq('id', workflowInstanceId).single();
    const snapshotLabel = (nodeId: string) => instance?.started_snapshot?.nodes?.find((n: any) => n.id === nodeId)?.label || null;
    const steps = await db.from('workflow_active_steps')
      .select('node_id, branch_id, workflow_nodes!workflow_active_steps_node_id_fkey ( label, node_type )')
      .eq('workflow_instance_id', workflowInstanceId).eq('status', 'active');
    if (!steps.error && steps.data?.length) {
      stepNames = [...new Set(steps.data.map((s: any) => snapshotLabel(s.node_id) || s.workflow_nodes?.label).filter(Boolean))] as string[];
    } else if (instance?.current_node_id) {
      const label = snapshotLabel(instance.current_node_id);
      if (label) stepNames = [label];
      else {
        const wf = await db.from('workflow_instances')
          .select('current_node_id, workflow_nodes!workflow_instances_current_node_id_fkey ( label, node_type )')
          .eq('id', workflowInstanceId).single();
        if (!wf.error && wf.data?.workflow_nodes) { const node = one(wf.data.workflow_nodes); stepNames = node?.label ? [node.label] : []; }
      }
    }
  }

  const canEdit = await accountService.canUserEditProject(userId, projectId, db);
  return {
    project: { ...data, workflow_instance_id: workflowInstanceId, departments, assigned_user: lead.data ?? null, stakeholders: stakeholderRows },
    stepNames,
    canEdit,
  };
}

async function formData(db: any, instanceId: string) {
  const { data: history, error } = await db.from('workflow_history')
    .select(`id, created_at, notes, form_response_id, to_node_id, transitioned_by,
      workflow_nodes!workflow_history_to_node_id_fkey(label),
      user_profiles!workflow_history_transitioned_by_fkey(name)`)
    .eq('workflow_instance_id', instanceId)
    .order('created_at', { ascending: true });
  if (error) return null;
  const entries: any[] = [];
  for (const entry of history || []) {
    const stepName = entry.workflow_nodes?.label || null;
    const submittedBy = entry.user_profiles?.name || null;
    if (entry.form_response_id) {
      const { data: response } = await db.from('form_responses')
        .select('response_data, submitted_at, form_template:form_templates(name, fields)')
        .eq('id', entry.form_response_id).single();
      if (response) entries.push({
        id: entry.id, formName: response.form_template?.name || null, stepName,
        submittedAt: response.submitted_at || entry.created_at, submittedBy,
        responseData: response.response_data || {}, fields: response.form_template?.fields || null, approvalDecision: null,
      });
    } else if (entry.notes) {
      try {
        const notes = JSON.parse(entry.notes);
        if (notes.type === 'inline_form' && notes.data) entries.push({
          id: entry.id, formName: notes.data.formName || null, stepName, submittedAt: entry.created_at, submittedBy,
          responseData: notes.data.responses || {}, fields: notes.data.fields || null, approvalDecision: null,
        });
      } catch { /* notes that are not JSON are skipped */ }
    }
  }
  return entries;
}

export const GET = api<{ projectId: string }>(async (request, ctx, params) => {
  const projectId = assertUuid(params.projectId, 'project id');
  const parsed = query.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) throw new HttpError(400, 'Invalid request');
  const { view, instanceId } = parsed.data;
  const db = ctx.supabase;

  switch (view) {
    case 'overview':
      return ok(await overview(db, projectId, ctx.userId));
    case 'status': {
      const { data, error } = await db.from('projects').select('status, completed_at, workflow_instance_id').eq('id', projectId).single();
      if (error) throw error;
      return ok(data);
    }
    case 'workflow-step': {
      if (!instanceId) throw new HttpError(400, 'instanceId is required');
      const { data, error } = await db.from('workflow_instances')
        .select('current_node_id, status, workflow_nodes!workflow_instances_current_node_id_fkey ( label, node_type )')
        .eq('id', instanceId).single();
      if (error) throw error;
      return ok(data);
    }
    case 'tasks': {
      const [tasks, projectHours] = await Promise.all([
        taskServiceDB.getTasksByProject(projectId, db),
        db.from('time_entries').select('hours_logged').eq('project_id', projectId).is('task_id', null),
      ]);
      return ok({ tasks, projectHours: (projectHours.data || []).reduce((sum: number, e: any) => sum + (e.hours_logged || 0), 0) });
    }
    case 'latest-run': {
      const { data } = await db.from('workflow_instances').select('id, status').eq('project_id', projectId)
        .in('status', ['active', 'completed']).order('started_at', { ascending: false }).limit(1);
      return ok(data?.[0] ?? null);
    }
    case 'contributors': {
      // project_contributors may not exist in every installation: no table, no contributors
      const { data: contributors, error } = await db.from('project_contributors')
        .select('user_id, contribution_type, last_contributed_at').eq('project_id', projectId).order('last_contributed_at', { ascending: false });
      if (error || !contributors?.length) return ok([]);
      const { data: users } = await db.from('user_profiles').select('id, name').in('id', contributors.map((c: any) => c.user_id));
      const names = new Map((users || []).map((u: any) => [u.id, u.name]));
      return ok(contributors.map((c: any) => ({ user_id: c.user_id, name: names.get(c.user_id) || 'Unknown User', contribution_type: c.contribution_type, last_contributed_at: c.last_contributed_at })));
    }
    case 'people': {
      const { data, error } = await db.from('user_profiles').select('id, name, email').order('name');
      if (error) throw error;
      return ok(data || []);
    }
    case 'form-data': {
      if (!instanceId) throw new HttpError(400, 'instanceId is required');
      return ok(await formData(db, instanceId));
    }
  }
});
