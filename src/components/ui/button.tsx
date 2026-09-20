import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium transition-[filter,background,color,border-color] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default:
          "relative border border-border/55 text-primary-foreground backdrop-blur-md bg-[linear-gradient(135deg,hsl(var(--primary)/0.98),hsl(var(--primary)/0.92)_55%,hsl(var(--primary)/0.88))] hover:brightness-[1.10] hover:saturate-[1.16] active:brightness-[1.05] active:saturate-[1.10] dark:border-border/60 dark:text-slate-50 dark:bg-[linear-gradient(135deg,hsl(var(--primary)/0.98),hsl(var(--primary)/0.92)_55%,hsl(var(--primary)/0.88))] dark:hover:brightness-[1.08] dark:hover:saturate-[1.22] dark:active:brightness-[1.04] dark:active:saturate-[1.14]",
        destructive:
          "bg-destructive text-destructive-foreground hover:bg-destructive/90 dark:hover:brightness-[1.8] dark:hover:saturate-[1.9]",
        outline:
          "border border-input bg-background dark:bg-muted/20 hover:bg-accent dark:hover:bg-muted/50 hover:text-accent-foreground",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost:
          "hover:bg-accent/60 hover:text-accent-foreground dark:hover:bg-muted/20 dark:hover:text-foreground",
        link:
          "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 rounded-md px-3 text-xs",
        lg: "h-10 rounded-md px-8",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button"
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    )
  }
)
Button.displayName = "Button"

export { Button, buttonVariants }