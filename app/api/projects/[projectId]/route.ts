import { NextRequest, NextResponse } from 'next/server';
import { createApiSupabaseClient, createAdminSupabaseClient } from '@/lib/supabase-server';
import { removeProjectFolder } from '@/lib/files';
import { saveFinancials } from '@/lib/project-financials';
import { hasPermission, isSuperadmin } from '@/lib/rbac';
import { Permission } from '@/lib/permissions';
import { checkDemoModeForDestructiveAction } from '@/lib/api-demo-guard';
import { logger } from '@/lib/debug-logger';
import { isValidUUID } from '@/lib/validation-helpers';
import { z } from 'zod';

const updateProjectSchema = z.object({
  name: z.string().min(1, 'Project name is required').max(500, 'Project name too long').optional(),
  description: z.string().max(5000).optional().nullable(),
  status: z.enum(['planning', 'in_progress', 'review', 'complete', 'on_hold']).optional(),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
  start_date: z.string().optional().nullable(),
  end_date: z.string().optional().nullable(),
  estimated_hours: z.number().min(0).max(100000).optional().nullable(),
  // Money: Decimal(14,2) + ISO currency code
  budget: z.number().min(0).max(999999999999.99).optional().nullable(),
  hourly_rate: z.number().min(0).max(999999999999.99).optional().nullable(),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, 'Currency must be a 3-letter ISO code such as INR').optional(),
  shared_with_client: z.boolean().optional(),
  assigned_user_id: z.string().uuid().optional().nullable(),
  notes: z.string().max(50000).optional().nullable(),
}).refine((data) => {
  if (data.start_date && data.end_date) {
    return data.end_date >= data.start_date;
  }
  return true;
}, { message: 'End date cannot be before start date', path: ['end_date'] });

/**
 * GET /api/projects/[projectId]
 * Get a single project's details
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  try {
    const { projectId } = await params;
    if (!isValidUUID(projectId)) {
      return NextResponse.json({ error: 'Invalid ID format' }, { status: 400 });
    }

    const supabase = createApiSupabaseClient(request);
    if (!supabase) {
      return NextResponse.json({ error: 'Database connection failed' }, { status: 500 });
    }

    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Get user profile with roles
    const { data: userProfile } = await supabase
      .from('user_profiles')
      .select(`
        *,
        user_roles!user_roles_user_id_fkey (
          roles (
            id,
            name,
            permissions,
            department_id
          )
        )
      `)
      .eq('id', user.id)
      .single();

    if (!userProfile) {
      return NextResponse.json({ error: 'User profile not found' }, { status: 404 });
    }

    // Get the project
    const { data: project, error: projectError } = await supabase
      .from('projects')
      .select('*')
      .eq('id', projectId)
      .single();

    if (projectError || !project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    // Check if user can view this project
    // Superadmins can view all projects
    if (!isSuperadmin(userProfile)) {
      // Check VIEW_PROJECTS permission
      const canView = await hasPermission(userProfile, Permission.VIEW_PROJECTS, {
        projectId,
        accountId: project.account_id
      }, supabase);

      if (!canView) {
        // Also check if user is assigned to the project
        const { data: assignment } = await supabase
          .from('project_assignments')
          .select('id')
          .eq('user_id', user.id)
          .eq('project_id', projectId)
          .is('removed_at', null)
          .single();

        if (!assignment && project.created_by !== user.id && project.assigned_user_id !== user.id) {
          return NextResponse.json({ error: 'Insufficient permissions to view project' }, { status: 403 });
        }
      }
    }

    return NextResponse.json({ success: true, project });
  } catch (error: unknown) {
    logger.error('Error in GET /api/projects/[projectId]:', {}, error as Error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * PUT /api/projects/[projectId]
 * Update a project (used by Kanban, Gantt, Table views)
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  try {
    const { projectId } = await params;
    if (!isValidUUID(projectId)) {
      return NextResponse.json({ error: 'Invalid ID format' }, { status: 400 });
    }

    const supabase = createApiSupabaseClient(request);
    if (!supabase) {
      return NextResponse.json({ error: 'Database connection failed' }, { status: 500 });
    }

    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Get user profile with roles
    const { data: userProfile } = await supabase
      .from('user_profiles')
      .select(`
        *,
        user_roles!user_roles_user_id_fkey (
          roles (
            id,
            name,
            permissions,
            department_id
          )
        )
      `)
      .eq('id', user.id)
      .single();

    if (!userProfile) {
      return NextResponse.json({ error: 'User profile not found' }, { status: 404 });
    }

    // Get the project to check permissions
    const { data: project, error: projectError } = await supabase
      .from('projects')
      .select('id, account_id, assigned_user_id')
      .eq('id', projectId)
      .single();

    if (projectError || !project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    // Check MANAGE_PROJECTS permission with project context (consolidated from EDIT_PROJECT)
    const canManageProjects = await hasPermission(userProfile, Permission.MANAGE_PROJECTS, {
      projectId,
      accountId: project.account_id
    }, supabase);

    if (!canManageProjects) {
      return NextResponse.json({ error: 'Insufficient permissions to edit project' }, { status: 403 });
    }

    let rawBody;
    try {
      rawBody = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }

    // Validate input
    const parseResult = updateProjectSchema.safeParse(rawBody);
    if (!parseResult.success) {
      const firstError = parseResult.error.issues[0];
      return NextResponse.json({ error: `${firstError.path.join('.')}: ${firstError.message}` }, { status: 400 });
    }
    const body = parseResult.data;

    // Build update object with only provided fields
    const updates: Record<string, unknown> = {};
    if (body.name !== undefined) updates.name = body.name;
    if (body.description !== undefined) updates.description = body.description;
    if (body.status !== undefined) updates.status = body.status;
    if (body.priority !== undefined) updates.priority = body.priority;
    if (body.start_date !== undefined) updates.start_date = body.start_date;
    if (body.end_date !== undefined) updates.end_date = body.end_date;
    if (body.estimated_hours !== undefined) updates.estimated_hours = body.estimated_hours;
    // Budget and hourly rate are stored in project_financials (manager-only table, G-6)
    const financialUpdates: { budget?: number | null; hourly_rate?: number | null; currency?: string } = {};
    if (body.budget !== undefined) financialUpdates.budget = body.budget;
    if (body.hourly_rate !== undefined) financialUpdates.hourly_rate = body.hourly_rate;
    if (body.currency !== undefined) financialUpdates.currency = body.currency;
    if (body.shared_with_client !== undefined) updates.shared_with_client = body.shared_with_client;
    if (body.assigned_user_id !== undefined) {
      // Project Manager must be an active internal user with manage_projects
      if (body.assigned_user_id) {
        // Read the candidate's role with the service client: row-level security hides other
        // users' role rows from a normal manager, which made every candidate look unqualified.
        // The caller's right to edit this project was checked above.
        const lookup = createAdminSupabaseClient() || supabase;
        const { data: pmRoles } = await lookup
          .from('user_roles')
          .select('roles!user_roles_role_id_fkey(permissions)')
          .eq('user_id', body.assigned_user_id);
        const { data: pmProfile } = await lookup
          .from('user_profiles').select('is_client, is_active, is_superadmin').eq('id', body.assigned_user_id).maybeSingle();
        const canManage = !!pmProfile?.is_superadmin || (pmRoles || []).some((r: { roles: unknown }) => {
          const role = (Array.isArray(r.roles) ? r.roles[0] : r.roles) as { permissions?: Record<string, boolean> } | null;
          return !!(role?.permissions?.manage_projects || role?.permissions?.manage_all_projects);
        });
        if (!pmProfile || pmProfile.is_client || pmProfile.is_active === false || !canManage) {
          return NextResponse.json({ error: 'Project Manager must be an active internal user with the manage_projects permission' }, { status: 400 });
        }
      }
      updates.assigned_user_id = body.assigned_user_id;
    }
    if (body.notes !== undefined) updates.notes = body.notes;

    const hasFinancialUpdates = Object.keys(financialUpdates).length > 0;
    if (Object.keys(updates).length === 0 && !hasFinancialUpdates) {
      return NextResponse.json({ error: 'No fields to update' }, { status: 400 });
    }

    if (hasFinancialUpdates) {
      try {
        // Written with the caller's session: the database only lets project managers write budgets
        await saveFinancials(supabase, projectId, financialUpdates, user.id);
      } catch (financialError) {
        logger.error('Error updating project budget:', {}, financialError as Error);
        const code = (financialError as { code?: string })?.code;
        return NextResponse.json(
          { error: code === '42501' ? 'Only a project manager can change the budget' : 'Failed to update project budget' },
          { status: code === '42501' ? 403 : 500 }
        );
      }
    }

    // Update the project
    const projectQuery = Object.keys(updates).length > 0
      ? supabase.from('projects').update(updates).eq('id', projectId).select().single()
      : supabase.from('projects').select().eq('id', projectId).single();
    const { data: updatedProject, error: updateError } = await projectQuery;

    if (updateError) {
      logger.error('Error updating project:', {}, updateError as unknown as Error);
      return NextResponse.json({ error: 'Failed to update project' }, { status: 500 });
    }

    // Add user as project collaborator if they made a meaningful update (notes, description)
    if (body.notes !== undefined || body.description !== undefined) {
      const { data: existingAssignment } = await supabase
        .from('project_assignments')
        .select('id, removed_at')
        .eq('project_id', projectId)
        .eq('user_id', user.id)
        .single();

      if (!existingAssignment) {
        // Insert new assignment
        await supabase.from('project_assignments').insert({
          project_id: projectId,
          user_id: user.id,
          role_in_project: 'collaborator',
          assigned_by: user.id,
          source_type: 'manual'
        });
      } else if (existingAssignment.removed_at) {
        // Reactivate removed assignment
        await supabase
          .from('project_assignments')
          .update({ removed_at: null, role_in_project: 'collaborator', source_type: 'manual' })
          .eq('id', existingAssignment.id);
      }
    }

    return NextResponse.json({ success: true, project: updatedProject });
  } catch (error: unknown) {
    logger.error('Error in PUT /api/projects/[projectId]:', {}, error as Error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * PATCH /api/projects/[projectId]
 * Partial update for a project (e.g., notes)
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  // PATCH uses the same logic as PUT for partial updates
  return PUT(request, { params });
}

/**
 * DELETE /api/projects/[projectId]
 * Delete a project
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  try {
    // Block in demo mode
    const blocked = checkDemoModeForDestructiveAction('delete_project');
    if (blocked) return blocked;

    const { projectId } = await params;
    if (!isValidUUID(projectId)) {
      return NextResponse.json({ error: 'Invalid ID format' }, { status: 400 });
    }

    const supabase = createApiSupabaseClient(request);
    if (!supabase) {
      return NextResponse.json({ error: 'Database connection failed' }, { status: 500 });
    }

    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Get user profile with roles
    const { data: userProfile } = await supabase
      .from('user_profiles')
      .select(`
        *,
        user_roles!user_roles_user_id_fkey (
          roles (
            id,
            name,
            permissions,
            department_id
          )
        )
      `)
      .eq('id', user.id)
      .single();

    if (!userProfile) {
      return NextResponse.json({ error: 'User profile not found' }, { status: 404 });
    }

    // Get the project to check permissions
    const { data: project, error: projectError } = await supabase
      .from('projects')
      .select('id, account_id')
      .eq('id', projectId)
      .single();

    if (projectError || !project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    // Check MANAGE_PROJECTS permission with project context (consolidated from DELETE_PROJECT)
    const canManageProjects = await hasPermission(userProfile, Permission.MANAGE_PROJECTS, {
      projectId,
      accountId: project.account_id
    }, supabase);

    if (!canManageProjects) {
      return NextResponse.json({ error: 'Insufficient permissions to delete project' }, { status: 403 });
    }

    // Remove stored files first (rows cascade, storage objects would otherwise be orphaned)
    const adminForFiles = createAdminSupabaseClient();
    if (adminForFiles) await removeProjectFolder(adminForFiles, projectId);

    // Delete the project
    const { error: deleteError } = await supabase
      .from('projects')
      .delete()
      .eq('id', projectId);

    if (deleteError) {
      logger.error('Error deleting project:', {}, deleteError as unknown as Error);
      return NextResponse.json({ error: 'Failed to delete project' }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    logger.error('Error in DELETE /api/projects/[projectId]:', {}, error as Error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
