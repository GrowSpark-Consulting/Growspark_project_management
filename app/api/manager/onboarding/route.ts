import { z } from 'zod'
import { api, ok, readJson, HttpError } from '@/lib/api/context'
import { onboardingStatus, updateOnboarding, ONBOARDING_STEPS } from '@/lib/onboarding-checklist'

// GET /api/manager/onboarding - the workspace setup checklist (workspace owner = superadmin)
export const GET = api(async (_request, ctx) => {
  if (!ctx.isSuperadmin) return ok({ visible: false })
  return ok({ visible: true, ...(await onboardingStatus(ctx.admin)) })
})

// POST /api/manager/onboarding { action: skip | unskip | dismiss | reopen, step? }
export const POST = api(async (request, ctx) => {
  if (!ctx.isSuperadmin) throw new HttpError(403, 'Only the workspace owner can change the setup checklist')
  const keys = ONBOARDING_STEPS.map((s) => s.key) as [string, ...string[]]
  const body = await readJson(request, z.object({ action: z.enum(['skip', 'unskip', 'dismiss', 'reopen']), step: z.enum(keys).optional() }))
  if ((body.action === 'skip' || body.action === 'unskip') && !body.step) throw new HttpError(400, 'Which step?')
  await updateOnboarding(ctx.admin, (st) => {
    if (body.action === 'skip') st.skipped.push(body.step!)
    if (body.action === 'unskip') st.skipped = st.skipped.filter((k) => k !== body.step)
    if (body.action === 'dismiss') st.dismissed = true
    if (body.action === 'reopen') st.dismissed = false
  })
  return ok({ visible: true, ...(await onboardingStatus(ctx.admin)) })
})
