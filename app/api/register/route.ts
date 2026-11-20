import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { createAdminSupabaseClient } from '@/lib/supabase-server'
import { registrationErrors, normalizePhone, TERMS_VERSION, type RegistrationInput } from '@/lib/registration-rules'
import { getRegistrationState, CLAIM_TIMEOUT_MS, CLOSED_MESSAGES, type RegistrationState } from '@/lib/registration-state'
import { logger } from '@/lib/debug-logger'

const UNAVAILABLE = 'The workspace database is not reachable right now. Nothing was created. Try again in a moment.'

function codeOk(given: string | undefined): boolean {
  const expected = process.env.REGISTRATION_CODE
  if (!expected) return true
  const a = Buffer.from(String(given || ''))
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

function closed(state: RegistrationState, extra?: string) {
  const reason = state.open ? 'registered' : state.reason
  const msg = CLOSED_MESSAGES[reason]
  return NextResponse.json({
    error: `${msg.title(state.workspaceName)}. ${extra ?? 'No account was created.'}`,
    code: 'REGISTRATION_CLOSED',
    reason,
    workspaceName: state.workspaceName,
  }, { status: 409 })
}

// GET /api/register - can a company be registered here, and is a registration code required?
export async function GET() {
  const admin = createAdminSupabaseClient()
  if (!admin) return NextResponse.json({ error: 'Server configuration error', code: 'UNAVAILABLE' }, { status: 500 })
  try {
    const state = await getRegistrationState(admin)
    return NextResponse.json({
      data: {
        open: state.open,
        reason: state.reason,
        companyName: state.open ? null : state.workspaceName,
        requiresCode: !!process.env.REGISTRATION_CODE,
        termsVersion: TERMS_VERSION,
      },
    }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    logger.error('Registration state unavailable', { error: (e as Error).message })
    return NextResponse.json({ error: UNAVAILABLE, code: 'UNAVAILABLE' }, { status: 503 })
  }
}

// POST /api/register - create the company workspace and its manager (first registration only).
// Stages: 1 claim the installation, 2 create the sign-in account, 3 profile + Superadmin role +
// registered_by in one database transaction. Any failure undoes the earlier stages.
export async function POST(request: NextRequest) {
  const admin = createAdminSupabaseClient()
  if (!admin) return NextResponse.json({ error: 'Server configuration error', code: 'UNAVAILABLE' }, { status: 500 })

  let body: Partial<RegistrationInput>
  try { body = await request.json() } catch { return NextResponse.json({ error: 'Invalid request body' }, { status: 400 }) }

  const fieldErrors = registrationErrors(body)
  if (Object.keys(fieldErrors).length) {
    return NextResponse.json({ error: 'Please fix the highlighted fields', fieldErrors }, { status: 400 })
  }
  if (!codeOk(body.registrationCode)) {
    return NextResponse.json({ error: 'The registration code is not correct', fieldErrors: { registrationCode: 'The registration code is not correct' } }, { status: 403 })
  }

  let state: RegistrationState
  try { state = await getRegistrationState(admin) } catch { return NextResponse.json({ error: UNAVAILABLE, code: 'UNAVAILABLE' }, { status: 503 }) }
  if (!state.open) return closed(state)

  const email = body.email!.trim().toLowerCase()
  const name = body.name!.trim()
  const phone = normalizePhone(body.phone!)!
  const now = new Date().toISOString()

  // 1. Claim the installation. Compare-and-swap: only one request can move registered_at from
  //    "empty" (or an abandoned claim older than CLAIM_TIMEOUT_MS with no manager) to now.
  //    The settings row is created first if a reset or cascade removed it.
  const { error: rowErr } = await admin.from('app_settings').upsert({ id: true }, { onConflict: 'id', ignoreDuplicates: true })
  if (rowErr) {
    logger.error('Registration: settings row', { error: rowErr.message })
    return NextResponse.json({ error: UNAVAILABLE, code: 'UNAVAILABLE' }, { status: 503 })
  }
  const cutoff = new Date(Date.now() - CLAIM_TIMEOUT_MS).toISOString()
  const { data: claimed, error: claimErr } = await admin.from('app_settings').update({
    registered_at: now,
    registered_by: null,
    company_name: body.companyName!.trim(),
    workspace_name: body.workspaceName!.trim(),
    workspace_slug: body.workspaceSlug!.trim(),
    company_phone: phone,
    terms_version: TERMS_VERSION,
    terms_accepted_at: now,
    onboarding: {},
    updated_at: now,
  }).eq('id', true).is('registered_by', null)
    .or(`registered_at.is.null,registered_at.lt.${cutoff}`)
    .select('id')
  if (claimErr) {
    logger.error('Registration: claim failed', { error: claimErr.message })
    return NextResponse.json({ error: 'Could not create the workspace. Nothing was created.' }, { status: 500 })
  }
  if (!claimed?.length) {
    // Lost the race to a simultaneous registration
    let latest: RegistrationState = { open: false, reason: 'in_progress', workspaceName: null, claimedAt: null }
    try {
      const now2 = await getRegistrationState(admin)
      if (!now2.open) latest = now2
    } catch { /* keep "in progress" */ }
    return closed(latest)
  }

  // Undo stage 1, only if the claim is still ours (never release someone else's registration)
  const release = async () => {
    const { error } = await admin.from('app_settings').update({
      registered_at: null, registered_by: null, workspace_slug: null, workspace_name: null, company_phone: null,
      terms_version: null, terms_accepted_at: null,
    }).eq('id', true).eq('registered_at', now).is('registered_by', null)
    if (error) logger.error('Registration: could not release the claim', { error: error.message })
    return !error
  }

  // 2. The manager's sign-in account (Supabase Auth; the auth trigger adds a plain profile)
  const { data: created, error: authErr } = await admin.auth.admin.createUser({
    email, password: body.password!, email_confirm: true, user_metadata: { name },
  })
  if (authErr || !created?.user) {
    await release()
    const dup = /already|registered|exists/i.test(authErr?.message || '')
    logger.error('Registration: account creation failed', { error: authErr?.message })
    return NextResponse.json(
      dup
        ? { error: 'An account with this email already exists. Nothing was created.', fieldErrors: { email: 'An account with this email already exists' } }
        : { error: `Could not create the account: ${authErr?.message || 'unknown error'}. Nothing was created.` },
      { status: dup ? 409 : 500 }
    )
  }
  const userId = created.user.id

  // 3. Profile (superadmin) + Superadmin role + registered_by: one transaction
  const { error: finishErr } = await admin.rpc('complete_workspace_registration', {
    p_user_id: userId, p_email: email, p_name: name, p_phone: phone,
  })
  if (finishErr) {
    logger.error('Registration: finishing failed, undoing', { error: finishErr.message })
    const { error: delErr } = await admin.auth.admin.deleteUser(userId)
    if (delErr) logger.error('Registration: could not delete the half-created account', { userId, error: delErr.message })
    const released = await release()
    return NextResponse.json({
      error: delErr || !released
        ? 'Could not finish creating the workspace, and the cleanup did not complete. Ask your administrator to check the installation (see Recovery in docs/onboarding-auth-plan.md).'
        : `Could not finish creating the workspace: ${finishErr.message}. Nothing was created; you can try again.`,
      code: delErr || !released ? 'REGISTRATION_INCOMPLETE' : undefined,
    }, { status: 500 })
  }

  // Verify the end state before reporting success
  const { data: done } = await admin.from('app_settings').select('registered_by, workspace_slug').eq('id', true).maybeSingle()
  if (done?.registered_by !== userId) {
    logger.error('Registration: verification failed', { userId, registeredBy: done?.registered_by })
    return NextResponse.json({ error: 'The workspace was not recorded correctly. Ask your administrator to check the installation.', code: 'REGISTRATION_INCOMPLETE' }, { status: 500 })
  }

  logger.info('Workspace registered', { userId, slug: done.workspace_slug })
  return NextResponse.json({ data: { email, workspaceSlug: done.workspace_slug, landing: '/manager' } }, { status: 201 })
}
