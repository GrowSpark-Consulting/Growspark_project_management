'use client';

import { StatusBadge } from '@/components/ui/badge';
import { TASK_STATUS_META, PRIORITY_TONE, statusLabel } from '@/lib/task-rules';

/** Task status: dot + word in the status tone (never colour alone). */
export function TaskStatusBadge({ status, className }: { status: string; className?: string }) {
  const meta = TASK_STATUS_META[status] || TASK_STATUS_META.todo;
  return <StatusBadge tone={meta.tone} className={className}>{statusLabel(status)}</StatusBadge>;
}

export function PriorityBadge({ priority }: { priority: string }) {
  const label = priority ? priority.charAt(0).toUpperCase() + priority.slice(1) : 'None';
  return <StatusBadge tone={PRIORITY_TONE[priority] || 'neutral'}>{label}</StatusBadge>;
}
