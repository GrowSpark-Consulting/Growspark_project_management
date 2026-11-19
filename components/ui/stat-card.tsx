import Link from 'next/link';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

export type StatDeltaTone = 'neutral' | 'success' | 'warning' | 'danger';

const DELTA_TONE: Record<StatDeltaTone, string> = {
  neutral: 'text-ink-muted',
  success: 'text-success font-medium',
  warning: 'text-warning font-medium',
  danger: 'text-danger font-medium',
};

interface StatCardProps {
  label: string;
  value: React.ReactNode;
  /** One line of context, e.g. "3 overdue this week". */
  delta?: React.ReactNode;
  /** Judge by meaning, not direction: more overdue tasks = danger. */
  deltaTone?: StatDeltaTone;
  icon?: LucideIcon;
  href?: string;
  className?: string;
}

/**
 * Grow Spark Workspace KPI tile: label, big number (28px/600, tabular), one line of context.
 * Use 3–4 per row and never more than 6 on a screen.
 */
export function StatCard({ label, value, delta, deltaTone = 'neutral', icon: Icon, href, className }: StatCardProps) {
  const body = (
    <>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[13px] leading-5 text-ink-muted">{label}</span>
        {Icon && <Icon className="h-[18px] w-[18px] text-ink-muted" strokeWidth={1.75} aria-hidden="true" />}
      </div>
      <div className="mt-1 text-[28px] leading-9 font-semibold tracking-[-0.01em] tabular-nums text-ink">{value}</div>
      {delta !== undefined && delta !== null && delta !== '' && (
        <div className={cn('mt-1 text-[13px] leading-5', DELTA_TONE[deltaTone])}>{delta}</div>
      )}
    </>
  );
  const cls = cn('block rounded-lg border border-line bg-surface p-5 shadow-sm', className);
  if (href) {
    return (
      <Link href={href} className={cn(cls, 'transition-colors duration-[120ms] hover:bg-hover')}>
        {body}
      </Link>
    );
  }
  return <div className={cls}>{body}</div>;
}
