'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { LucideIcon } from 'lucide-react';

export interface SidebarItemProps {
  href: string;
  label: string;
  icon: LucideIcon;
  badge?: number | string;
  disabled?: boolean;
  exactMatch?: boolean;
}

/** Shared classes for a Grow Spark nav item on the dark sidebar (36px, radius-md, 18px icon). */
export const sidebarItemClass = (isActive: boolean) =>
  cn(
    'flex h-9 items-center gap-3 rounded-md px-2 text-sm text-[var(--on-sidebar)] transition-colors duration-[120ms]',
    'focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]',
    isActive ? 'bg-[var(--sidebar-active)] font-medium' : 'hover:bg-[var(--sidebar-active)]'
  );

export function SidebarItem({
  href,
  label,
  icon: Icon,
  badge,
  disabled = false,
  exactMatch = false,
}: SidebarItemProps) {
  const pathname = usePathname();

  // Check if this route is active
  const isActive = exactMatch
    ? pathname === href
    : pathname === href || pathname.startsWith(`${href}/`);

  if (disabled) {
    return (
      <div className="flex h-9 items-center gap-3 rounded-md px-2 text-sm text-[var(--on-sidebar-muted)] opacity-60 cursor-not-allowed">
        <Icon className="h-[18px] w-[18px] flex-shrink-0" strokeWidth={1.75} />
        <span className="truncate">{label}</span>
      </div>
    );
  }

  return (
    <Link href={href} aria-current={isActive ? 'page' : undefined} className={sidebarItemClass(isActive)}>
      <Icon className="h-[18px] w-[18px] flex-shrink-0 opacity-85" strokeWidth={1.75} />
      <span className="truncate flex-1">{label}</span>
      {badge !== undefined && (
        <span className="ml-auto text-xs tabular-nums text-[var(--on-sidebar-muted)]">{badge}</span>
      )}
    </Link>
  );
}
