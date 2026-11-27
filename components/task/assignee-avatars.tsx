'use client';

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * The people on a task as small initials badges (a task can be shared by several people). With more than one person
 * it also shows how many have completed their part.
 */
export function AssigneeAvatars({ assignees, fallbackName, max = 3 }: { assignees?: any[]; fallbackName?: string | null; max?: number }) {
  const people = (assignees || []).filter(Boolean);
  if (people.length === 0) {
    return fallbackName ? <span className="text-xs text-gray-500 truncate max-w-[80px]" title={fallbackName}>{fallbackName.split(' ')[0]}</span> : null;
  }
  const names = people.map((a) => a.user?.name || 'Team member');
  const initials = (n: string) => n.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  const done = people.filter((a) => a.status === 'done').length;
  return (
    <span className="inline-flex items-center gap-1.5" title={names.join(', ')} data-testid="assignee-avatars">
      <span className="flex -space-x-1.5">
        {people.slice(0, max).map((a, i) => (
          <span key={a.user_id} className={`inline-flex h-5 w-5 items-center justify-center rounded-full border border-white text-[9px] font-medium ${a.status === 'done' ? 'bg-green-100 text-green-800' : 'bg-gray-200 text-gray-700'}`}>
            {initials(names[i])}
          </span>
        ))}
        {people.length > max && (
          <span className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-white bg-gray-100 text-[9px] text-gray-600">+{people.length - max}</span>
        )}
      </span>
      {people.length > 1 ? <span className="text-[11px] text-gray-500">{done}/{people.length}</span> : <span className="text-xs text-gray-500 truncate max-w-[80px]">{names[0].split(' ')[0]}</span>}
    </span>
  );
}
