import { NextRequest, NextResponse } from 'next/server';
import { createApiSupabaseClient, createAdminSupabaseClient } from '@/lib/supabase-server';
import { userHasProjectAccess, hasPermission } from '@/lib/rbac';
import { Permission } from '@/lib/permissions';
import { notify, getProjectTeamIds, getProjectClientIds } from '@/lib/notify';
import { logger } from '@/lib/debug-logger';
import { isValidUUID } from '@/lib/validation-helpers';
import { readCursor, applyCursor, cursorPage } from '@/lib/pagination';

/**
 * GET /api/projects/[projectId]/updates
 * Get all updates for a project
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

    // Get user profile
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

    // Check project access - if user has access to the project, they can view updates
    const hasAccess = await userHasProjectAccess(userProfile, projectId, supabase);
    if (!hasAccess) {
      return NextResponse.json({ error: 'Insufficient permissions to view project updates' }, { status: 403 });
    }

    // Get updates with user info, newest first. With limit/cursor: one chunk plus nextCursor / hasMore
    // ("Load more"); without: every update (as before).
    // Note: workflow_history relationship is optional and fetched separately if needed
    const sp = new URL(request.url).searchParams;
    const chunked = sp.has('limit') || sp.has('cursor');
    const page = readCursor(sp);
    const listQuery = supabase
      .from('project_updates')
      .select(`
        id,
        project_id,
        content,
        created_by,
        workflow_history_id,
        client_visible,
        created_at,
        updated_at,
        user_profiles:created_by(id, name, email, image, is_client)
      `)
      .eq('project_id', projectId);
    const { data: updates, error } = chunked
      ? await applyCursor(listQuery, page)
      : await listQuery.order('created_at', { ascending: false });

    if (error) {
      logger.error('Error fetching updates:', {}, error as unknown as Error);
      return NextResponse.json({ error: 'Failed to fetch updates' }, { status: 500 });
    }

    if (chunked) {
      const { rows, cursor } = cursorPage(updates || [], page);
      return NextResponse.json({ updates: rows, nextCursor: cursor.nextCursor, hasMore: cursor.hasMore });
    }
    return NextResponse.json({ updates: updates || [] });
  } catch (error: unknown) {
    logger.error('Error in GET /api/projects/[projectId]/updates:', {}, error as Error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * POST /api/projects/[projectId]/updates
 * Create a new update for a project
 */
export async function POST(
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

    // Get user profile
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

    // Check project access - if user has access to the project, they can create updates
    const hasAccess = await userHasProjectAccess(userProfile, projectId, supabase);
    if (!hasAccess) {
      return NextResponse.json({ error: 'Insufficient permissions to create updates' }, { status: 403 });
    }

    // Check if project is completed (read-only mode)
    const { data: project } = await supabase
      .from('projects')
      .select('status')
      .eq('id', projectId)
      .single();

    if (project?.status === 'complete') {
      return NextResponse.json({
        error: 'Cannot add updates to a completed project. The project is in read-only mode.'
      }, { status: 400 });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }
    const { content } = body;
    const clientVisible = body.client_visible === true;

    if (!content || !content.trim()) {
      return NextResponse.json({ error: 'Update content is required' }, { status: 400 });
    }

    if (content.length > 5000) {
      return NextResponse.json({ error: 'Update content must be 5000 characters or less' }, { status: 400 });
    }

    // Only project managers may share updates with the client
    if (clientVisible) {
      const canShare = await hasPermission(userProfile, Permission.MANAGE_PROJECTS, { projectId }, supabase)
        || await hasPermission(userProfile, Permission.MANAGE_ALL_PROJECTS, undefined, supabase);
      if (!canShare) {
        return NextResponse.json({ error: 'Only a project manager can share updates with the client' }, { status: 403 });
      }
    }

    // Create update
    const { data: update, error } = await supabase
      .from('project_updates')
      .insert({
        project_id: projectId,
        content: content.trim(),
        created_by: user.id,
        client_visible: clientVisible,
      })
      .select(`
        *,
        user_profiles:user_profiles(id, name, email, image)
      `)
      .single();

    if (error) {
      logger.error('Error creating update:', {}, error as unknown as Error);
      return NextResponse.json({ error: 'Failed to create update' }, { status: 500 });
    }

    // Add user as project collaborator if not already assigned
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

    const admin = createAdminSupabaseClient();
    if (admin) {
      const { data: proj } = await admin.from('projects').select('name').eq('id', projectId).maybeSingle();
      const recipients = clientVisible
        ? [...(await getProjectTeamIds(admin, projectId)), ...(await getProjectClientIds(admin, projectId))]
        : await getProjectTeamIds(admin, projectId);
      await notify(admin, recipients, {
        type: 'project_update', title: `Update on ${proj?.name || 'a project'}`,
        message: `${userProfile.name || 'Someone'}: ${content.trim().slice(0, 140)}`,
        link: `/projects/${projectId}`, projectId,
      }, user.id);
    }

    return NextResponse.json({ success: true, update }, { status: 201 });
  } catch (error: unknown) {
    logger.error('Error in POST /api/projects/[projectId]/updates:', {}, error as Error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
