import { NextRequest, NextResponse } from 'next/server';
import { createApiSupabaseClient } from '@/lib/supabase-server';
import { hasPermission, isSuperadmin } from '@/lib/rbac';
import { Permission } from '@/lib/permissions';
import { sendClientInvitation } from '@/lib/client-portal-service';
import { validateRequestBody, sendClientInvitationSchema } from '@/lib/validation-schemas';
import { hasAccountAccessServer } from '@/lib/access-control-server';
import { logger } from '@/lib/debug-logger';
import { isValidUUID } from '@/lib/validation-helpers';
import { sendEmail } from '@/lib/email/mailer';
import { clientInvitationEmailHtml, clientInvitationEmailText } from '@/lib/email/templates/client-invitation';
import { buildWhatsAppUrl } from '@/lib/portal';

// POST /api/accounts/[id]/invite-client - Send client portal invitation
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ accountId: string }> }
) {
  try {
    const { accountId } = await params;

    if (!isValidUUID(accountId)) {
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

    // Check MANAGE_CLIENT_INVITES permission
    const canInvite = await hasPermission(userProfile, Permission.MANAGE_CLIENT_INVITES, undefined, supabase);
    if (!canInvite) {
      return NextResponse.json({ error: 'Insufficient permissions to send client invitations' }, { status: 403 });
    }

    // Verify user has access to this account
    // Superadmins and org-wide account viewers have access to every account
    const hasAccess = isSuperadmin(userProfile)
      || await hasPermission(userProfile, Permission.VIEW_ALL_ACCOUNTS, undefined, supabase)
      || await hasAccountAccessServer(supabase, user.id, accountId);
    if (!hasAccess) {
      return NextResponse.json({
        error: 'You do not have access to this account'
      }, { status: 403 });
    }

    // Validate request body
    const body = await request.json();
    const validation = validateRequestBody(sendClientInvitationSchema, body);
    if (!validation.success) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }

    // Send invitation
    const invitation = await sendClientInvitation({
      accountId: accountId,
      email: validation.data.email,
      invitedBy: user.id,
      expiresInDays: validation.data.expires_in_days
    });

    // Send invitation email
    const inviteUrl = `${process.env.NEXT_PUBLIC_APP_URL}/client-invite/${invitation.token}`;

    // Fetch account name for email
    const { data: account } = await supabase
      .from('accounts')
      .select('name')
      .eq('id', accountId)
      .single();

    const sendEmailToo = (body as { send_email?: boolean }).send_email !== false;
    const phone = typeof (body as { phone?: unknown }).phone === 'string' ? (body as { phone: string }).phone : null;
    const whatsappUrl = buildWhatsAppUrl(
      `Hello! You're invited to follow your projects with ${account?.name || 'us'} on Project Management. Create your client account here (valid 7 days): ${inviteUrl}`,
      phone
    );
    if (!sendEmailToo) {
      return NextResponse.json({ success: true, invitation, acceptUrl: inviteUrl, whatsappUrl, emailSent: false }, { status: 201 });
    }

    const emailResult = await sendEmail({
      to: invitation.email,
      subject: `You're invited to ${account?.name || 'a project'} on Project Management`,
      html: clientInvitationEmailHtml({
        accountName: account?.name || 'Your Account',
        inviteUrl,
        expiresInDays: 7,
      }),
      text: clientInvitationEmailText({
        accountName: account?.name || 'Your Account',
        inviteUrl,
        expiresInDays: 7,
      }),
    });

    if (!emailResult.success) {
      logger.warn('Failed to send client invitation email', { email: invitation.email, error: emailResult.error });
      // Don't fail the request — invitation is created, email can be resent
    }

    return NextResponse.json({ success: true, invitation, acceptUrl: inviteUrl, whatsappUrl, emailSent: emailResult.success }, { status: 201 });
  } catch (error: unknown) {
    const err = error as Error;
    logger.error('Error in POST /api/accounts/[id]/invite-client', {}, err);

    if (err.message?.includes('pending invitation already exists')) {
      return NextResponse.json({ error: 'A pending invitation already exists for this email' }, { status: 409 });
    }
    if (err.message?.includes('internal user') || err.message?.includes('already exists')) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }

    return NextResponse.json({ error: 'Failed to send invitation' }, { status: 500 });
  }
}
