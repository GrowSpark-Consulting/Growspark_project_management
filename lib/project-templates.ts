/**
 * Project templates: blueprint = tasks (+ subtasks), milestones and dependencies,
 * with dates stored as day offsets from the project start.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

export interface BlueprintTask {
  key: string;
  name: string;
  description?: string | null;
  priority?: string;
  estimated_hours?: number | null;
  start_offset_days?: number | null;
  duration_days?: number | null;
  parent_key?: string | null;
}
export interface Blueprint {
  tasks: BlueprintTask[];
  milestones: { name: string; description?: string | null; offset_days: number; client_visible?: boolean }[];
  dependencies: { task_key: string; depends_on_key: string }[];
}

function daysBetween(from: string, to: string): number {
  return Math.round((new Date(`${to.slice(0, 10)}T00:00:00Z`).getTime() - new Date(`${from.slice(0, 10)}T00:00:00Z`).getTime()) / 86400000);
}

export function addDaysIso(base: string, days: number): string {
  const d = new Date(`${base.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export async function buildBlueprint(db: any, project: any): Promise<Blueprint> {
  const [{ data: tasks }, { data: milestones }] = await Promise.all([
    db.from('tasks').select('id, name, description, priority, estimated_hours, start_date, due_date, parent_task_id').eq('project_id', project.id).order('created_at'),
    db.from('milestones').select('name, description, date, client_visible').eq('project_id', project.id).order('date'),
  ]);
  const taskIds = (tasks || []).map((t: any) => t.id);
  const { data: deps } = taskIds.length
    ? await db.from('task_dependencies').select('task_id, depends_on_task_id').in('task_id', taskIds)
    : { data: [] };
  const base: string =
    project.start_date ||
    (tasks || []).map((t: any) => t.start_date).filter(Boolean).sort()[0] ||
    new Date().toISOString().slice(0, 10);

  return {
    tasks: (tasks || []).map((t: any) => ({
      key: t.id,
      name: t.name,
      description: t.description,
      priority: t.priority,
      estimated_hours: t.estimated_hours,
      start_offset_days: t.start_date ? daysBetween(base, t.start_date) : null,
      duration_days: t.start_date && t.due_date ? daysBetween(t.start_date, t.due_date) : null,
      parent_key: t.parent_task_id,
    })),
    milestones: (milestones || []).map((m: any) => ({
      name: m.name, description: m.description, offset_days: daysBetween(base, m.date), client_visible: m.client_visible,
    })),
    dependencies: (deps || []).map((d: any) => ({ task_key: d.task_id, depends_on_key: d.depends_on_task_id })),
  };
}

/** Copy a blueprint into an existing (new) project. */
export async function applyBlueprint(db: any, projectId: string, startDate: string, blueprint: Blueprint, userId: string) {
  const keyToId = new Map<string, string>();
  const ordered = [
    ...blueprint.tasks.filter((t) => !t.parent_key),
    ...blueprint.tasks.filter((t) => t.parent_key),
  ];
  for (const t of ordered) {
    const start = t.start_offset_days != null ? addDaysIso(startDate, t.start_offset_days) : null;
    const due = start && t.duration_days != null ? addDaysIso(start, t.duration_days) : null;
    const { data, error } = await db.from('tasks').insert({
      project_id: projectId,
      name: t.name,
      description: t.description || null,
      priority: ['low', 'medium', 'high', 'urgent'].includes(t.priority || '') ? t.priority : 'medium',
      estimated_hours: t.estimated_hours ?? null,
      remaining_hours: t.estimated_hours ?? null,
      actual_hours: 0,
      start_date: start,
      due_date: due,
      status: 'todo',
      created_by: userId,
      parent_task_id: t.parent_key ? keyToId.get(t.parent_key) || null : null,
    }).select('id').single();
    if (error) throw error;
    keyToId.set(t.key, data.id);
  }
  if (blueprint.milestones.length) {
    const { error } = await db.from('milestones').insert(blueprint.milestones.map((m) => ({
      project_id: projectId, name: m.name, description: m.description || null,
      date: addDaysIso(startDate, m.offset_days || 0), client_visible: m.client_visible ?? true, created_by: userId,
    })));
    if (error) throw error;
  }
  const deps = blueprint.dependencies
    .map((d) => ({ task_id: keyToId.get(d.task_key), depends_on_task_id: keyToId.get(d.depends_on_key), dependency_type: 'finish_to_start' }))
    .filter((d) => d.task_id && d.depends_on_task_id);
  if (deps.length) {
    const { error } = await db.from('task_dependencies').insert(deps);
    if (error) throw error;
  }
  return { tasks: keyToId.size, milestones: blueprint.milestones.length, dependencies: deps.length };
}
