'use client';

import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { PAGE_SIZES, type PageInfo } from '@/lib/pagination';

interface PaginationBarProps {
  pagination: PageInfo | null | undefined;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
  /** A new page is on its way: the controls stay visible but are disabled */
  loading?: boolean;
  /** Plural noun for the count, e.g. "projects" */
  itemLabel?: string;
  className?: string;
}

/** Page numbers to show: always the first and last, the current one with a neighbour each side, gaps as null. */
function pageNumbers(current: number, total: number): (number | null)[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const pages = new Set([1, total, current - 1, current, current + 1].filter((p) => p >= 1 && p <= total));
  const sorted = Array.from(pages).sort((a, b) => a - b);
  const out: (number | null)[] = [];
  sorted.forEach((p, i) => {
    if (i > 0 && p - sorted[i - 1] > 1) out.push(null);
    out.push(p);
  });
  return out;
}

/**
 * Shared pagination controls for server-paged tables: "21–40 of 153", Previous / page numbers / Next and the
 * page size (20 / 50 / 100). On small screens the page numbers collapse to "Page 2 of 8".
 */
export function PaginationBar({ pagination, onPageChange, onPageSizeChange, loading = false, itemLabel = 'items', className }: PaginationBarProps) {
  if (!pagination || pagination.total === 0) return null;
  const { page, pageSize, total, totalPages, hasNextPage, hasPreviousPage } = pagination;
  const first = (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);

  return (
    <nav
      aria-label="Pagination"
      aria-busy={loading}
      data-testid="pagination-bar"
      className={cn('flex flex-col gap-3 pt-3 sm:flex-row sm:items-center sm:justify-between', className)}
    >
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <span data-testid="pagination-range">
          {first.toLocaleString()}–{last.toLocaleString()} of {total.toLocaleString()} {itemLabel}
        </span>
        {loading && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-label="Loading" />}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Select value={String(pageSize)} onValueChange={(v) => onPageSizeChange(Number(v))} disabled={loading}>
          <SelectTrigger size="sm" className="w-[110px]" aria-label="Rows per page">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PAGE_SIZES.map((size) => (
              <SelectItem key={size} value={String(size)}>{size} / page</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Button
          variant="outline"
          size="sm"
          onClick={() => onPageChange(page - 1)}
          disabled={!hasPreviousPage || loading}
          aria-label="Previous page"
        >
          <ChevronLeft className="h-4 w-4" />
          <span className="hidden sm:inline">Previous</span>
        </Button>

        <span className="text-sm text-muted-foreground sm:hidden">Page {page} of {totalPages}</span>
        <div className="hidden items-center gap-1 sm:flex">
          {pageNumbers(page, totalPages).map((p, i) =>
            p === null ? (
              <span key={`gap-${i}`} className="px-1 text-sm text-muted-foreground">…</span>
            ) : (
              <Button
                key={p}
                variant={p === page ? 'default' : 'ghost'}
                size="icon-sm"
                onClick={() => p !== page && onPageChange(p)}
                disabled={loading}
                aria-label={`Page ${p}`}
                aria-current={p === page ? 'page' : undefined}
              >
                {p}
              </Button>
            )
          )}
        </div>

        <Button
          variant="outline"
          size="sm"
          onClick={() => onPageChange(page + 1)}
          disabled={!hasNextPage || loading}
          aria-label="Next page"
        >
          <span className="hidden sm:inline">Next</span>
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </nav>
  );
}
