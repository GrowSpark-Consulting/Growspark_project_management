import { NextRequest, NextResponse } from 'next/server';
import { createApiSupabaseClient, createAdminSupabaseClient } from '@/lib/supabase-server';
import { requireAuthentication, handleGuardError } from '@/lib/server-guards';
import { invitationAuthority } from '@/lib/invitation-access';
import { logger } from '@/lib/debug-logger';

// DELETE - Revoke a pending invitation
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    // Auth + permission check
    const user = await requireAuthentication(request);
    const supabase = createApiSupabaseClient(request);
    const authority = await invitationAuthority(user, supabase);
    if (!authority) {
      return NextResponse.json({ error: "You don't have permission to manage invitations" }, { status: 403 });
    }

    // Use admin client to bypass RLS for invitation management
    const adminSupabase = createAdminSupabaseClient();
    if (!adminSupabase) {
      return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
    }

    // Verify invitation exists and is pending
    const { data: invitation, error: fetchError } = await adminSupabase
      .from('user_invitations')
      .select('id, status, invited_by')
      .eq('id', id)
      .single();

    if (fetchError || !invitation) {
      logger.error('Invitation not found for revoke', { invitationId: id, error: fetchError?.message });
      return NextResponse.json({ error: 'Invitation not found' }, { status: 404 });
    }
    if (authority === 'own' && invitation.invited_by !== user.id) {
      return NextResponse.json({ error: 'You can only manage invitations you sent' }, { status: 403 });
    }

    if (invitation.status === 'pending') {
      // Soft delete: revoke pending invitations
      const { data: updated, error: updateError } = await adminSupabase
        .from('user_invitations')
        .update({ status: 'revoked', revoked_at: new Date().toISOString(), revoked_by: user.id })
        .eq('id', id)
        .select()
        .single();

      if (updateError) {
        logger.error('Failed to revoke invitation', { error: updateError.message, invitationId: id });
        return NextResponse.json({ error: 'Failed to revoke invitation' }, { status: 500 });
      }

      return NextResponse.json({ invitation: updated });
    }

    // Hard delete: remove non-pending invitations (revoked, accepted, expired)
    const { error: deleteError } = await adminSupabase
      .from('user_invitations')
      .delete()
      .eq('id', id);

    if (deleteError) {
      logger.error('Failed to delete invitation', { error: deleteError.message, invitationId: id });
      return NextResponse.json({ error: 'Failed to delete invitation' }, { status: 500 });
    }

    return NextResponse.json({ deleted: true });

  } catch (error: unknown) {
    return handleGuardError(error);
  }
}
