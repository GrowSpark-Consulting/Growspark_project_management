import { NextRequest, NextResponse } from 'next/server';
import { createApiSupabaseClient, createAdminSupabaseClient } from '@/lib/supabase-server';
import { clientRejectProject } from '@/lib/client-portal-service';
import { notify, getProjectManagerIds } from '@/lib/notify';
import { z } from 'zod';
import { validateRequestBody } from '@/lib/validation-schemas';
import { logger } from '@/lib/debug-logger';

const rejectProjectSchema = z.object({
  workflow_instance_id: z.string().uuid('Invalid workflow instance ID'),
  notes: z.string().max(2000, 'Notes too long'),
  issues: z.array(z.string()).optional()
});

// POST /api/client/portal/projects/[id]/reject - Reject project at workflow approval node
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  
  try {
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

    // Phase 9: Client permissions are hardcoded - verify user is a client with account access
    if (!userProfile.is_client || !userProfile.client_account_id) {
      return NextResponse.json({ error: 'Client access required' }, { status: 403 });
    }

    // Validate request body
    const body = await request.json();
    const validation = validateRequestBody(rejectProjectSchema, body);
    if (!validation.success) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }

    // Reject project (pass authenticated supabase client for proper RLS context)
    const result = await clientRejectProject({
      projectId: id,
      workflowInstanceId: validation.data.workflow_instance_id,
      clientUserId: user.id,
      notes: validation.data.notes,
      issues: validation.data.issues || [],
    });

    const admin = createAdminSupabaseClient();
    if (admin) {
      // client-raised issues are visible to the client who reported them
      await admin.from('project_issues').update({ client_visible: true }).eq('project_id', id).eq('created_by', user.id);
      await notify(admin, await getProjectManagerIds(admin, id), {
        type: 'client_decision', title: 'Client requested changes',
        message: `${userProfile.name || 'The client'} rejected the current step: ${validation.data.notes}`,
        link: `/projects/${id}`, projectId: id,
      });
    }

    return NextResponse.json({
      ...result,
      message: 'Project rejected. Issues have been logged.'
    }, { status: 200 });
  } catch (error: unknown) {
    const message = (error as Error)?.message || '';
    if (/not found|not a client approval|not an approval|not active|does not have access/i.test(message)) {
      return NextResponse.json({ error: message }, { status: 400 });
    }
    logger.error('Error in POST /api/client/portal/projects/[id]/reject', {}, error as Error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
