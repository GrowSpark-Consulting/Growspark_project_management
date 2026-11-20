import { NextRequest, NextResponse } from 'next/server';
import { roleGrantRefusal, actorAuthority } from '@/lib/role-guard';
import { invitationAuthority } from '@/lib/invitation-access';
import crypto from 'crypto';
import { createApiSupabaseClient, createAdminSupabaseClient } from '@/lib/supabase-server';
import { requireAuthentication, handleGuardError } from '@/lib/server-guards';
import { sendEmail } from '@/lib/email/mailer';
import { invitationEmailTemplate } from '@/lib/email/templates/invitation';
import { logger } from '@/lib/debug-logger';

import { buildWhatsAppUrl } from '@/lib/portal';

// POST - Create a new invitation and send email
export async function POST(request: NextRequest) {
  try {
    // Auth + permission check
    const user = await requireAuthentication(request);
    const supabase = createApiSupabaseClient(request);
    const authority = await invitationAuthority(user, supabase);
    if (!authority) {
      return NextResponse.json({ error: "You don't have permission to manage invitations" }, { status: 403 });
    }

    const body = await request.json();
    const { email, name, roleId, departmentId } = body;
    const sendEmailToo = body.send_email !== false;
    const phone = typeof body.phone === 'string' ? body.phone : null;
    const projectIds: string[] = Array.isArray(body.projectIds)
      ? Array.from(new Set((body.projectIds as unknown[]).filter((p): p is string => typeof p === 'string' && /^[0-9a-f-]{36}$/i.test(p))))
      : [];
    if (projectIds.length > 50) {
      return NextResponse.json({ error: 'Choose at most 50 projects' }, { status: 400 });
    }

    // Validate inputs
    if (!email || typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      return NextResponse.json({ error: 'A valid email address is required' }, { status: 400 });
    }

    if (!name || typeof name !== 'string' || !name.trim()) {
      return NextResponse.json({ error: 'Name is required' }, { status: 400 });
    }

    if (!roleId || typeof roleId !== 'string') {
      return NextResponse.json({ error: 'Role ID is required' }, { status: 400 });
    }

    // Verify role exists
    const adminSupabase = createAdminSupabaseClient();
    if (!adminSupabase) {
      return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
    }

    const { data: role, error: roleError } = await adminSupabase
      .from('roles')
      .select('id, name, is_system_role, permissions, department_id, departments(id, name)')
      .eq('id', roleId)
      .single();

    if (roleError || !role) {
      return NextResponse.json({ error: 'Invalid role ID' }, { status: 400 });
    }

    // No role escalation: system roles only by a superadmin; otherwise only roles within the inviter's own permissions
    const refusal = await roleGrantRefusal(adminSupabase, user.id, role);
    if (refusal) {
      return NextResponse.json({ error: refusal }, { status: 403 });
    }

    // Department (optional): the person joins it when they accept (department_members)
    let department: { id: string; name: string } | null = null;
    if (departmentId) {
      const { data: dept } = typeof departmentId === 'string'
        ? await adminSupabase.from('departments').select('id, name').eq('id', departmentId).maybeSingle()
        : { data: null };
      if (!dept) {
        return NextResponse.json({ error: 'That department does not exist' }, { status: 400 });
      }
      department = dept;
    }

    // Check for existing pending invitation for this email
    const { data: existingInvite } = await adminSupabase
      .from('user_invitations')
      .select('id, status')
      .eq('email', email.trim().toLowerCase())
      .eq('status', 'pending')
      .single();

    if (existingInvite) {
      return NextResponse.json(
        { error: 'A pending invitation already exists for this email address' },
        { status: 409 }
      );
    }

    // Check if user already exists
    const { data: existingUser } = await adminSupabase
      .from('user_profiles')
      .select('id')
      .eq('email', email.trim().toLowerCase())
      .single();

    if (existingUser) {
      return NextResponse.json(
        { error: 'A user with this email address already exists' },
        { status: 409 }
      );
    }

    // Projects to join on acceptance: each must exist, be open, and be one the inviter can manage
    if (projectIds.length) {
      const { data: projects } = await adminSupabase.from('projects').select('id, name, assigned_user_id, archived_at, status').in('id', projectIds);
      const list = (projects || []) as Array<{ id: string; name: string; assigned_user_id: string | null; archived_at: string | null; status: string }>;
      if (list.length !== projectIds.length) {
        return NextResponse.json({ error: 'One of the selected projects does not exist' }, { status: 400 });
      }
      const closed = list.find((p) => p.archived_at || p.status === 'complete');
      if (closed) {
        return NextResponse.json({ error: `"${closed.name}" is archived or complete` }, { status: 400 });
      }
      const { superadmin, perms } = await actorAuthority(adminSupabase, user.id);
      if (!superadmin && !perms.has('manage_all_projects')) {
        const { data: memberOf } = await adminSupabase.from('project_assignments').select('project_id').eq('user_id', user.id).is('removed_at', null).in('project_id', projectIds);
        const mine = new Set((memberOf || []).map((m: { project_id: string }) => m.project_id));
        const notManaged = list.find((p) => !(perms.has('manage_projects') && (mine.has(p.id) || p.assigned_user_id === user.id)));
        if (notManaged) {
          return NextResponse.json({ error: `You can't add people to "${notManaged.name}"` }, { status: 403 });
        }
      }
    }

    // Generate secure token
    const token = crypto.randomBytes(32).toString('hex');

    // Set expiration to 7 days from now
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    // Insert invitation using admin client (service role bypasses RLS)
    const { data: invitation, error: insertError } = await adminSupabase
      .from('user_invitations')
      .insert({
        email: email.trim().toLowerCase(),
        name: name.trim(),
        role_id: roleId,
        department_id: departmentId || null,
        project_ids: projectIds,
        phone: phone || null,
        invited_by: user.id,
        token,
        status: 'pending',
        expires_at: expiresAt.toISOString(),
      })
      .select()
      .single();

    if (insertError) {
      logger.error('Failed to create invitation', { error: insertError.message });
      return NextResponse.json({ error: 'Failed to create invitation' }, { status: 500 });
    }

    // Build accept URL from the incoming request (auto-detects domain)
    const proto = request.headers.get('x-forwarded-proto') || 'http';
    const host = request.headers.get('host') || 'localhost:3100';
    const appUrl = `${proto}://${host}`;
    const acceptUrl = `${appUrl}/invite/${token}`;

    // The department chosen for this person (not the role's)
    const deptName = department?.name;

    // Send invitation email
    const emailContent = invitationEmailTemplate({
      recipientName: name.trim(),
      inviterName: user.name || user.email || 'An administrator',
      roleName: role.name,
      departmentName: deptName,
      acceptUrl,
      expiresIn: '7 days',
    });

    const emailResult = sendEmailToo
      ? await sendEmail({
          to: email.trim().toLowerCase(),
          subject: emailContent.subject,
          html: emailContent.html,
          text: emailContent.text,
        })
      : { success: false, error: 'skipped' };

    if (sendEmailToo && !emailResult.success) {
      logger.error('Failed to send invitation email', { error: emailResult.error });
      // Don't fail the request - invitation was created, email can be resent
    }

    // Free WhatsApp share link (click-to-chat) - no WhatsApp Business API needed
    const whatsappUrl = buildWhatsAppUrl(
      `Hi ${name.trim()}, you're invited to join our team on Project Management as ${role.name}. Accept your invitation here (valid 7 days): ${acceptUrl}`,
      phone
    );

    return NextResponse.json({
      invitation,
      emailSent: emailResult.success,
      acceptUrl,
      whatsappUrl,
    }, { status: 201 });

  } catch (error: unknown) {
    return handleGuardError(error);
  }
}

// GET - List all invitations
export async function GET(request: NextRequest) {
  try {
    // Auth + permission check
    const user = await requireAuthentication(request);
    const supabase = createApiSupabaseClient(request);
    const authority = await invitationAuthority(user, supabase);
    if (!authority) {
      return NextResponse.json({ error: "You don't have permission to manage invitations" }, { status: 403 });
    }

    if (!supabase) {
      return NextResponse.json({ error: 'Database connection failed' }, { status: 500 });
    }

    // Managers without manage_user_roles see the invitations they sent (read on the server)
    const listClient = authority === 'own' ? (createAdminSupabaseClient() || supabase) : supabase;
    let listQuery = listClient
      .from('user_invitations')
      .select(`
        *,
        roles:role_id(id, name),
        departments:department_id(id, name),
        inviter:invited_by(id, name, email)
      `)
      .order('created_at', { ascending: false });
    if (authority === 'own') listQuery = listQuery.eq('invited_by', user.id);
    const { data: invitations, error } = await listQuery;

    if (error) {
      logger.error('Failed to fetch invitations', { error: error.message });
      return NextResponse.json({ error: 'Failed to fetch invitations' }, { status: 500 });
    }

    return NextResponse.json({ invitations: invitations || [] });

  } catch (error: unknown) {
    return handleGuardError(error);
  }
}
