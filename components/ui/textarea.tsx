import * as React from "react"

import { cn } from "@/lib/utils"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "border-input placeholder:text-muted-foreground hover:border-ink-muted focus-visible:border-primary focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)] aria-invalid:border-danger aria-invalid:bg-danger-soft flex field-sizing-content min-h-16 w-full rounded-md border bg-surface px-3 py-2 text-sm text-ink transition-[color,border-color] duration-[120ms] outline-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
