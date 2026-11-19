import { cn } from '@/lib/utils';

/** Product name shown in the sidebar header (Grow Spark Workspace: chip + product name). */
export const PRODUCT_NAME = 'Project Management';

/**
 * Product chip: the ONLY place the product colour appears (design system rule).
 * Project Management = moss (`product-projects`), letter "P".
 */
export function BrandChip({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'grid h-7 w-7 flex-none place-items-center rounded-md bg-[var(--product-projects)] text-[13px] font-semibold text-[var(--surface)]',
        className
      )}
    >
      P
    </span>
  );
}

/** Chip + product name, for light top navigation bars. */
export function HeaderBrand({ className }: { className?: string }) {
  return (
    <span className={cn('flex min-w-0 items-center gap-2', className)}>
      <BrandChip className="h-8 w-8 text-[15px]" />
      <span className="truncate text-[17px] font-semibold text-[var(--ink)]">{PRODUCT_NAME}</span>
    </span>
  );
}

/** Chip + product name, for the dark sidebar header. */
export function SidebarBrand({ className }: { className?: string }) {
  return (
    <span className={cn('flex min-w-0 items-center gap-2', className)}>
      <BrandChip />
      <span className="truncate text-[15px] font-semibold text-[var(--on-sidebar)]">{PRODUCT_NAME}</span>
    </span>
  );
}
