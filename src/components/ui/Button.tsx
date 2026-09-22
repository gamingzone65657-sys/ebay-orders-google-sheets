import clsx from "clsx";
import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md";

/**
 * Variants are defined against semantic tokens, so the same class strings
 * produce a correct button on either theme. `primary` deliberately keeps
 * blue-600 in dark mode: lightening it to blue-500 would drop white-on-blue
 * below the AA contrast threshold at button text sizes.
 */
const VARIANTS: Record<Variant, string> = {
  primary:
    "bg-primary text-primary-foreground border-primary hover:bg-primary-hover hover:border-primary-hover " +
    "disabled:opacity-55",
  secondary:
    "bg-secondary text-secondary-foreground border-input hover:bg-secondary-hover " +
    "disabled:text-muted-foreground disabled:opacity-70",
  ghost:
    "bg-transparent text-muted-foreground border-transparent hover:bg-muted hover:text-foreground " +
    "disabled:text-muted-foreground disabled:opacity-60",
  danger:
    "bg-card text-danger border-danger-border hover:bg-danger-bg " +
    "disabled:opacity-55",
};

const SIZES: Record<Size, string> = {
  sm: "h-8 px-2.5 text-xs gap-1.5",
  md: "h-9 px-3.5 text-sm gap-2",
};

function classes(variant: Variant, size: Size, className?: string) {
  return clsx(
    "inline-flex items-center justify-center rounded-md border font-medium",
    "transition-colors disabled:cursor-not-allowed",
    VARIANTS[variant],
    SIZES[size],
    className,
  );
}

interface ButtonProps extends ComponentProps<"button"> {
  variant?: Variant;
  size?: Size;
  children: ReactNode;
}

export function Button({
  variant = "secondary",
  size = "md",
  className,
  children,
  ...props
}: ButtonProps) {
  return (
    <button className={classes(variant, size, className)} {...props}>
      {children}
    </button>
  );
}

interface ButtonLinkProps extends ComponentProps<typeof Link> {
  variant?: Variant;
  size?: Size;
  children: ReactNode;
}

export function ButtonLink({
  variant = "secondary",
  size = "md",
  className,
  children,
  ...props
}: ButtonLinkProps) {
  return (
    <Link className={classes(variant, size, className)} {...props}>
      {children}
    </Link>
  );
}
