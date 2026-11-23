/**
 * Shared API foundation for the three-portal routes.
 *
 * - getCtx(): authenticated user + permissions + Supabase clients
 * - api(): route wrapper (auth, audience check, uniform error responses)
 * - getProjectAccess()/requireProject(): one place for project access rules
 * - getScope(): projects a manager (or team lead) is responsible for
 *
 * Access checks run with the service-role client so they are not affected by
 * nested RLS; every route still filters data explicitly by these checks.
 */
import { NextRequest, NextResponse } from 'next/server';
import type { ZodType } from 'zod';
import { createApiSupabaseClient, createAdminSupabaseClient } from '@/lib/supabase-server';
import { requireAuthentication, AuthenticationError, PermissionError, ForbiddenError } from '@/lib/server-guards';
import { profilePermissions, isSuperadminProfile, isClientProfile } from '@/lib/portal';
import { isValidUUID } from '@/lib/validation-helpers';
import { logger } from '@/lib/debug-logger';
import { recordAudit } from '@/lib/audit';

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Db = any;

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

export interface ApiCtx {
  userId: string;
  user: any;
  supabase: Db; // user session (RLS applies)
  admin: Db; // service role (server-side only, after checks)
  perms: Set<string>;
  isSuperadmin: boolean;
  isClient: boolean;
  has: (permission: string) => boolean;
}

export async function getCtx(request: NextRequest): Promise<ApiCtx> {
  const supabase = createApiSupabaseClient(request);
  const admin = createAdminSupabaseClient();
  if (!supabase || !admin) throw new HttpError(500, 'Server is not configured');
  const user = await requireAuthentication(request);
  if ((user as any).is_active === false) throw new ForbiddenError('Your account has been deactivated');
  const perms = profilePermissions(user as any);
  const isSuperadmin = isSuperadminProfile(user as any);
  return {
    userId: user.id,
    user,
    supabase,
    admin,
    perms,
    isSuperadmin,
    isClient: isClientProfile(user as any),
    has: (permission: string) => isSuperadmin || perms.has(permission),
  };
}

type Audience = 'internal' | 'client' | 'any';
type Handler<P> = (request: NextRequest, ctx: ApiCtx, params: P) => Promise<NextResponse>;

export function api<P = Record<string, string>>(handler: Handler<P>, audience: Audience = 'internal') {
  return async (request: NextRequest, routeCtx: { params: Promise<P> }) => {
    try {
      const params = (routeCtx?.params ? await routeCtx.params : {}) as P;
      const ctx = await getCtx(request);
      if (audience === 'internal' && ctx.isClient) throw new HttpError(403, 'Not available for client accounts');
      if (audience === 'client' && !ctx.isClient) throw new HttpError(403, 'Client access required');
      return await handler(request, ctx, params);
    } catch (error) {
      return errorResponse(error);
    }
  };
}

/**
 * The Postgres error behind a failure. supabase-js returns it directly; Prisma (lib/db) wraps it, so
 * its original SQLSTATE is unwrapped and the same mapping applies on both paths.
 */
function postgresError(error: unknown): { code?: string; message?: string } | null {
  if (!error || typeof error !== 'object') return null;
  const e = error as { code?: string; message?: string; meta?: { driverAdapterError?: { cause?: { originalCode?: string; code?: string; originalMessage?: string; message?: string } } } };
  const cause = e.meta?.driverAdapterError?.cause;
  if (cause && (cause.originalCode || cause.code)) {
    return { code: cause.originalCode || cause.code, message: cause.originalMessage || cause.message };
  }
  return e;
}

export function errorResponse(error: unknown): NextResponse {
  if (error instanceof HttpError) return NextResponse.json({ error: error.message }, { status: error.status });
  if (error instanceof AuthenticationError) return NextResponse.json({ error: error.message }, { status: 401 });
  if (error instanceof PermissionError || error instanceof ForbiddenError) {
    return NextResponse.json({ error: error.message }, { status: 403 });
  }
  const pg = postgresError(error);
  if (pg?.code === 'P2025') return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (pg && typeof pg === 'object' && pg.code) {
    if (pg.code === '42501') return NextResponse.json({ error: pg.message || 'Permission denied' }, { status: 403 });
    if (pg.code === '55006') return NextResponse.json({ error: pg.message }, { status: 409 });
    if (pg.code === '23505') return NextResponse.json({ error: 'This record already exists' }, { status: 409 });
    if (['23514', '23503', '22P02', '23502'].includes(pg.code)) {
      return NextResponse.json({ error: pg.message || 'Invalid data' }, { status: 400 });
    }
  }
  logger.error('API error', {}, error as Error);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

/** Throw database errors so errorResponse can map them. */
export function check(result: { data: any; error: any }): any {
  if (result.error) throw result.error;
  return result.data;
}

export function ok(data: unknown, status = 200, meta?: unknown) {
  return NextResponse.json(meta === undefined ? { data } : { data, meta }, { status });
}

export async function readJson<T>(request: NextRequest, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new HttpError(400, `${issue.path.join('.') || 'body'}: ${issue.message}`);
  }
  return parsed.data;
}

export function assertUuid(id: string | null | undefined, what = 'ID'): string {
  if (!id || !isValidUUID(id)) throw new HttpError(400, `Invalid ${what}`);
  return id;
}

// ---------------------------------------------------------------------------
// Project access
// ---------------------------------------------------------------------------
export interface ProjectAccess {
  project: any;
  isMember: boolean;
  canView: boolean;
  canContribute: boolean;
  canManage: boolean;
}

export async function getProjectAccess(ctx: ApiCtx, projectId: string): Promise<ProjectAccess | null> {
  if (!isValidUUID(projectId)) return null;
  const { data: project } = await ctx.admin.from('projects').select('*').eq('id', projectId).maybeSingle();
  if (!project) return null;

  let isMember = project.created_by === ctx.userId || project.assigned_user_id === ctx.userId;
  if (!isMember) {
    const { data } = await ctx.admin
      .from('project_assignments').select('id')
      .eq('project_id', projectId).eq('user_id', ctx.userId).is('removed_at', null).limit(1);
    isMember = (data?.length || 0) > 0;
  }
  if (!isMember && project.account_id) {
    const { data } = await ctx.admin
      .from('accounts').select('id').eq('id', project.account_id).eq('account_manager_id', ctx.userId).limit(1);
    isMember = (data?.length || 0) > 0;
  }
  if (!isMember) {
    const { data } = await ctx.admin
      .from('tasks').select('id').eq('project_id', projectId).eq('assigned_to', ctx.userId).limit(1);
    isMember = (data?.length || 0) > 0;
  }

  const all = ctx.isSuperadmin || ctx.has('manage_all_projects');
  const internal = !ctx.isClient;
  return {
    project,
    isMember,
    canView: internal && (all || ctx.has('view_all_projects') || isMember),
    canContribute: internal && !project.archived_at && (all || isMember),
    canManage: internal && (all || (ctx.has('manage_projects') && isMember)),
  };
}

export async function requireProject(
  ctx: ApiCtx,
  projectId: string,
  level: 'view' | 'contribute' | 'manage' = 'view',
  opts: { allowComplete?: boolean } = {}
): Promise<ProjectAccess> {
  const access = await getProjectAccess(ctx, projectId);
  if (!access || !access.canView) throw new HttpError(404, 'Project not found');
  if (level === 'contribute' || level === 'manage') {
    if (access.project.archived_at && level === 'contribute') throw new HttpError(409, 'Project is archived (read-only)');
    if (!opts.allowComplete && access.project.status === 'complete') {
      throw new HttpError(400, 'Project is complete and read-only. Reopen it first.');
    }
  }
  if (level === 'contribute' && !access.canContribute) throw new HttpError(403, 'You are not on this project team');
  if (level === 'manage' && !access.canManage) throw new HttpError(403, 'Only a project manager can do this');
  // SEC-12: write access granted only because of a superadmin / override right is recorded
  if ((level === 'contribute' || level === 'manage') && !access.isMember && (ctx.isSuperadmin || ctx.has('manage_all_projects'))) {
    await recordAudit(ctx.admin, {
      actorId: ctx.userId, action: 'override_access', entityType: 'project', entityId: projectId, projectId,
      details: { level, via: ctx.isSuperadmin ? 'superadmin' : 'manage_all_projects', project: access.project.name },
    });
  }
  return access;
}

/** Task + its project access. Reviewer = tasks.reviewer_id (not reviewing own task) or a project manager. */
export async function requireTask(ctx: ApiCtx, taskId: string, level: 'view' | 'contribute' | 'manage' = 'view') {
  assertUuid(taskId, 'task ID');
  const { data: task } = await ctx.admin.from('tasks').select('*').eq('id', taskId).maybeSingle();
  if (!task) throw new HttpError(404, 'Task not found');
  const access = await requireProject(ctx, task.project_id, level === 'manage' ? 'manage' : level);
  const canReview = access.canManage || (task.reviewer_id === ctx.userId && task.assigned_to !== ctx.userId);
  const canEditDetails = access.canManage || task.created_by === ctx.userId;
  return { task, access, canReview, canEditDetails };
}

/** Internal, active user who is on the project team (valid assignee). */
export async function assertValidAssignee(ctx: ApiCtx, projectId: string, userId: string) {
  assertUuid(userId, 'assignee');
  const { data: profile } = await ctx.admin
    .from('user_profiles').select('id, is_client, is_active').eq('id', userId).maybeSingle();
  if (!profile || profile.is_client || profile.is_active === false) {
    throw new HttpError(400, 'Assignee must be an active internal user');
  }
  const { data: project } = await ctx.admin
    .from('projects').select('created_by, assigned_user_id').eq('id', projectId).maybeSingle();
  if (project && (project.created_by === userId || project.assigned_user_id === userId)) return;
  const { data: member } = await ctx.admin
    .from('project_assignments').select('id')
    .eq('project_id', projectId).eq('user_id', userId).is('removed_at', null).limit(1);
  if (!member || member.length === 0) throw new HttpError(400, 'Assignee must be a member of this project team');
}

// ---------------------------------------------------------------------------
// Manager scope
// ---------------------------------------------------------------------------
export interface Scope {
  all: boolean;
  projectIds: string[];
}

/** Projects the user oversees. Org-wide for superadmin / manage_all / view_all. */
export async function getScope(ctx: ApiCtx): Promise<Scope> {
  if (ctx.isSuperadmin || ctx.has('manage_all_projects') || ctx.has('view_all_projects')) {
    const { data } = await ctx.admin.from('projects').select('id');
    return { all: true, projectIds: (data || []).map((p: any) => p.id) };
  }
  const ids = new Set<string>();
  const [assigned, owned, accounts] = await Promise.all([
    ctx.admin.from('project_assignments').select('project_id').eq('user_id', ctx.userId).is('removed_at', null),
    ctx.admin.from('projects').select('id').or(`created_by.eq.${ctx.userId},assigned_user_id.eq.${ctx.userId}`),
    ctx.admin.from('accounts').select('id').eq('account_manager_id', ctx.userId),
  ]);
  (assigned.data || []).forEach((r: any) => ids.add(r.project_id));
  (owned.data || []).forEach((r: any) => ids.add(r.id));
  const accountIds = (accounts.data || []).map((a: any) => a.id);
  if (accountIds.length) {
    const { data } = await ctx.admin.from('projects').select('id').in('account_id', accountIds);
    (data || []).forEach((r: any) => ids.add(r.id));
  }
  return { all: false, projectIds: Array.from(ids) };
}

export function requireManager(ctx: ApiCtx) {
  if (ctx.isClient) throw new HttpError(403, 'Not available for client accounts');
  const allowed = ctx.isSuperadmin || ['manage_projects', 'manage_all_projects', 'approve_timesheets', 'view_all_projects']
    .some((p) => ctx.perms.has(p));
  if (!allowed) throw new HttpError(403, 'Manager access required');
}

/** Monday-based week start (matches get_week_start_date in the database). */
export function weekStart(date: Date | string = new Date()): string {
  const d = typeof date === 'string' ? new Date(`${date.slice(0, 10)}T00:00:00Z`) : new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function today(): string {
  const d = new Date();
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())).toISOString().slice(0, 10);
}
