import { NextRequest, NextResponse } from 'next/server'
import { createAdminSupabaseClient } from '@/lib/supabase-server'
import { notify } from '@/lib/notify'
import { assigneeIdsByTask } from '@/lib/task-assignees'
import { logger } from '@/lib/debug-logger'

/* eslint-disable @typescript-eslint/no-explicit-any */
// POST /api/cron/deadline-reminders  (Authorization: Bearer $CRON_SECRET)
// Run daily from the server crontab, e.g.:
//   0 8 * * * curl -s -X POST -H "Authorization: Bearer $CRON_SECRET" https://your-host/api/cron/deadline-reminders
export async function POST(request: NextRequest) {
  const secret = process.env.CRON_SECRET
  const auth = request.headers.get('authorization') || ''
  if (!secret || auth !== `Bearer ${secret}`) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const admin = createAdminSupabaseClient()
  if (!admin) return NextResponse.json({ error: 'Server is not configured' }, { status: 500 })

  const now = new Date()
  const today = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())).toISOString().slice(0, 10)
  const tomorrowDate = new Date(`${today}T00:00:00Z`); tomorrowDate.setUTCDate(tomorrowDate.getUTCDate() + 1)
  const tomorrow = tomorrowDate.toISOString().slice(0, 10)

  const { data: tasks, error } = await admin
    .from('tasks')
    .select('id, name, due_date, assigned_to, project_id, status')
    .not('assigned_to', 'is', null)
    .not('status', 'in', '(done)')
    .lte('due_date', tomorrow)
  if (error) {
    logger.error('deadline reminders query failed', {}, error as unknown as Error)
    return NextResponse.json({ error: 'Query failed' }, { status: 500 })
  }

  // Everyone on each task gets the reminder (shared tasks have several assignees)
  const onTask = await assigneeIdsByTask(admin, ((tasks || []) as any[]).map((t) => t.id))
  let sent = 0
  for (const t of (tasks || []) as any[]) {
    const due = String(t.due_date).slice(0, 10)
    const kind = due === tomorrow ? 'due_tomorrow' : due === today ? 'due_today' : 'overdue'
    await notify(admin, [t.assigned_to, ...(onTask.get(t.id) || [])], {
      type: 'deadline',
      title: kind === 'due_tomorrow' ? 'Task due tomorrow' : kind === 'due_today' ? 'Task due today' : 'Task overdue',
      message: `"${t.name}" ${kind === 'overdue' ? `was due on ${due}` : `is due ${kind === 'due_today' ? 'today' : 'tomorrow'}`}`,
      link: `/projects/${t.project_id}?task=${t.id}`,
      projectId: t.project_id,
      dedupeKey: `${kind}:${t.id}:${today}`,
    })
    sent += 1
  }
  return NextResponse.json({ success: true, checked: tasks?.length || 0, sent })
}
