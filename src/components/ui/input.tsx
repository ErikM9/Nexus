import * as React from "react"
import { cn } from "@/lib/utils"

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {}

const Input = React.forwardRef<HTMLInputElement, InputProps>(({ className, type, ...props }, ref) => {
  return (
    <input
      type={type}
      className={cn(
        "flex h-9 w-full rounded-md border px-3 py-1 text-sm",
        "transition-[border-radius,border-color] duration-200 ease-out",
        "file:border-0 file:bg-transparent file:text-sm file:font-medium",
        "placeholder:text-muted-foreground focus-visible:outline-none",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "bg-[hsl(var(--field))] text-[hsl(var(--field-foreground))]",
        "border-[hsl(var(--field-border))]",
        className
      )}
      ref={ref}
      {...props}
    />
  )
})
Input.displayName = "Input"

export { Input }