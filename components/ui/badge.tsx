import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

// Grow Spark Workspace badge: 22px, radius-sm, 12px/500. Status tones always pair a colour
// with a word (never colour alone): success / warning / danger / info / accent / neutral.
const badgeVariants = cva(
  "inline-flex h-[22px] items-center justify-center gap-1 whitespace-nowrap rounded-sm border border-transparent px-2 text-xs font-medium",
  {
    variants: {
      variant: {
        default: "bg-primary-soft text-primary",
        secondary: "bg-sunken text-ink-muted",
        destructive: "bg-danger-soft text-danger",
        outline: "border-line bg-transparent text-ink",
        neutral: "bg-sunken text-ink-muted",
        success: "bg-success-soft text-success",
        warning: "bg-warning-soft text-warning",
        danger: "bg-danger-soft text-danger",
        info: "bg-info-soft text-info",
        accent: "bg-clay-soft text-clay",
        primary: "bg-primary-soft text-primary",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  )
}

export type BadgeTone = NonNullable<VariantProps<typeof badgeVariants>["variant"]>

/** Status badge with the leading dot: use for statuses (Done, Overdue, In review ...). */
function StatusBadge({ tone = "neutral", className, children, ...props }: Omit<BadgeProps, "variant"> & { tone?: BadgeTone }) {
  return (
    <Badge variant={tone} className={className} {...props}>
      <span aria-hidden="true" className="h-1.5 w-1.5 flex-none rounded-full bg-current" />
      {children}
    </Badge>
  )
}

export { Badge, StatusBadge, badgeVariants }
