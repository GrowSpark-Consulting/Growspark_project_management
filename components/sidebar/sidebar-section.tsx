'use client';

import { cn } from '@/lib/utils';
import { ReactNode } from 'react';

export interface SidebarSectionProps {
  title?: string;
  children: ReactNode;
  className?: string;
  collapsible?: boolean;
  defaultCollapsed?: boolean;
}

/** Sidebar group: 12px uppercase heading in on-sidebar-muted (the only ALL CAPS in the system). */
export function SidebarSection({
  title,
  children,
  className,
}: SidebarSectionProps) {
  return (
    <div className={cn('py-1', className)}>
      {title && (
        <div className="px-2 pt-4 pb-2">
          <span className="text-xs font-medium uppercase tracking-[0.04em] text-[var(--on-sidebar-muted)]">
            {title}
          </span>
        </div>
      )}
      <div className="space-y-0.5">
        {children}
      </div>
    </div>
  );
}
