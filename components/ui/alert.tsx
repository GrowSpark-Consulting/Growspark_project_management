import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const alertVariants = cva(
  // Grow Spark alert: soft tone background, ink text, the icon carries the tone colour
  "relative w-full rounded-md border border-transparent px-4 py-3 text-sm text-ink grid has-[>svg]:grid-cols-[calc(var(--spacing)*4.5)_1fr] grid-cols-[0_1fr] has-[>svg]:gap-x-3 gap-y-0.5 items-start [&>svg]:size-[18px] [&>svg]:translate-y-0.5",
  {
    variants: {
      variant: {
        default: "border-line bg-card [&>svg]:text-ink-muted",
        destructive: "bg-danger-soft [&>svg]:text-danger",
        info: "bg-info-soft [&>svg]:text-info",
        success: "bg-success-soft [&>svg]:text-success",
        warning: "bg-warning-soft [&>svg]:text-warning",
        danger: "bg-danger-soft [&>svg]:text-danger",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Alert({
  className,
  variant,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  return (
    <div
      data-slot="alert"
      role="alert"
      className={cn(alertVariants({ variant }), className)}
      {...props}
    />
  )
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-title"
      className={cn(
        "col-start-2 line-clamp-1 min-h-4 font-medium tracking-tight",
        className
      )}
      {...props}
    />
  )
}

function AlertDescription({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-description"
      className={cn(
        "text-ink col-start-2 grid justify-items-start gap-1 text-sm [&_p]:leading-relaxed",
        className
      )}
      {...props}
    />
  )
}

export { Alert, AlertTitle, AlertDescription }
