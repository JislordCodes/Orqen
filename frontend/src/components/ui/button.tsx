import * as React from "react";
import { cn } from "@/lib/utils";

type Variant = "primary" | "secondary" | "ghost" | "outline" | "signal" | "danger";
type Size = "xs" | "sm" | "md" | "icon" | "icon-sm";

const variants: Record<Variant, string> = {
  primary: "bg-ink text-paper hover:bg-ink-2 shadow-card",
  signal: "bg-signal text-white hover:brightness-95 shadow-card",
  secondary: "bg-card text-ink border border-line hover:border-line-2 hover:bg-white shadow-card",
  outline: "border border-line-2 text-ink hover:bg-sunk",
  ghost: "text-ink-2 hover:bg-sunk hover:text-ink",
  danger: "bg-bad text-white hover:brightness-95",
};
const sizes: Record<Size, string> = {
  xs: "h-6 px-2 text-[11px] rounded-md gap-1",
  sm: "h-7 px-2.5 text-xs rounded-lg gap-1.5",
  md: "h-9 px-3.5 text-[13px] rounded-lg gap-2",
  icon: "h-8 w-8 rounded-lg",
  "icon-sm": "h-6 w-6 rounded-md",
};

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

/** shadcn/ui-shaped Button, re-styled for Orqen's paper theme. */
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant = "secondary", size = "md", ...p }, ref) => (
  <button
    ref={ref}
    className={cn(
      "inline-flex shrink-0 select-none items-center justify-center font-medium transition-all duration-150 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal/40",
      variants[variant],
      sizes[size],
      className,
    )}
    {...p}
  />
));
Button.displayName = "Button";
