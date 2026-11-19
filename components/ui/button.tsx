import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

// Grow Spark Workspace button: 36px (control-md), radius-md, 14px/500, verb-first labels.
// Primary = moss; secondary/outline = surface with a strong border; danger = outlined brick.
// Focus: 2px clay ring with 2px offset (never removed).
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors duration-[120ms] ease-out disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)] aria-invalid:border-destructive",
  {
    variants: {
      variant: {
        default: "border border-primary bg-primary text-on-primary hover:bg-primary-hover hover:border-primary-hover",
        destructive:
          "border border-danger bg-surface text-danger hover:bg-danger-soft",
        outline:
          "border border-line-strong bg-surface text-ink hover:bg-hover",
        secondary:
          "border border-line-strong bg-surface text-ink hover:bg-hover",
        ghost:
          "border border-transparent bg-transparent text-ink hover:bg-hover",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 has-[>svg]:px-3",
        sm: "h-[30px] gap-1.5 px-3 text-[13px] has-[>svg]:px-2.5",
        lg: "h-11 px-6 has-[>svg]:px-4",
        icon: "size-9",
        "icon-sm": "size-[30px]",
        "icon-lg": "size-11",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot : "button"

  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
