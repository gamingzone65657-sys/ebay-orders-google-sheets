import clsx from "clsx";
import type { ReactNode } from "react";

/* -------------------------------------------------------------------------- */
/* Card                                                                        */
/* -------------------------------------------------------------------------- */

export function Card({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      data-theme-surface
      className={clsx(
        "rounded-lg border border-border bg-card text-card-foreground",
        "shadow-[var(--shadow-card)]",
        className,
      )}
    >
      {children}
    </section>
  );
}

export function CardHeader({
  title,
  description,
  actions,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4">
      <div className="min-w-0">
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        {description ? (
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </header>
  );
}

export function CardBody({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={clsx("px-5 py-4", className)}>{children}</div>;
}

/* -------------------------------------------------------------------------- */
/* Badge                                                                       */
/* -------------------------------------------------------------------------- */

export type BadgeTone =
  | "neutral"
  | "success"
  | "warning"
  | "danger"
  | "info"
  ;

/**
 * Status hues are preserved in both themes rather than flattened to greys —
 * a red badge must still read as a problem in dark mode. The tokens behind
 * these classes swap solid pastels for translucent tints when dark.
 */
const BADGE_TONES: Record<BadgeTone, string> = {
  neutral: "bg-muted text-muted-foreground ring-border",
  success: "bg-success-bg text-success ring-success-border",
  warning: "bg-warning-bg text-warning ring-warning-border",
  danger: "bg-danger-bg text-danger ring-danger-border",
  info: "bg-info-bg text-info ring-info-border",
};

export function Badge({
  tone = "neutral",
  children,
  className,
}: {
  tone?: BadgeTone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={clsx(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset whitespace-nowrap",
        BADGE_TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Empty state                                                                 */
/* -------------------------------------------------------------------------- */

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      <p className="text-sm font-medium text-foreground">{title}</p>
      {description ? (
        <p className="max-w-md text-sm text-muted-foreground">{description}</p>
      ) : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Form fields                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Form controls use `bg-card` rather than the page background so they read as
 * raised on both themes, and an explicit text colour so the browser does not
 * fall back to its own dark-on-dark default.
 */
export const inputClass =
  "h-9 w-full rounded-md border border-input bg-card px-3 text-sm text-foreground " +
  "placeholder:text-muted-foreground disabled:bg-muted disabled:text-muted-foreground";

export const selectClass =
  "h-9 w-full rounded-md border border-input bg-card px-2 text-sm text-foreground " +
  "disabled:bg-muted disabled:text-muted-foreground";

export const textareaClass =
  "w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground " +
  "placeholder:text-muted-foreground disabled:bg-muted disabled:text-muted-foreground";

/** Checkboxes and radios; `accent-primary` tints the native control. */
export const checkboxClass =
  "h-4 w-4 rounded border-input accent-[var(--primary)] text-primary";

export function Field({
  label,
  hint,
  htmlFor,
  children,
  className,
}: {
  label: string;
  hint?: ReactNode;
  htmlFor?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={clsx("space-y-1.5", className)}>
      <label
        htmlFor={htmlFor}
        className="block text-xs font-medium text-foreground"
      >
        {label}
      </label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Definition list (used by the detail panels)                                 */
/* -------------------------------------------------------------------------- */

export function DetailList({
  items,
}: {
  items: { label: string; value: ReactNode }[];
}) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
      {items.map((item) => (
        <div key={item.label} className="min-w-0">
          <dt className="text-xs text-muted-foreground">{item.label}</dt>
          <dd className="mt-0.5 truncate text-sm text-foreground">
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/* -------------------------------------------------------------------------- */
/* Notice                                                                      */
/* -------------------------------------------------------------------------- */

export function Notice({
  tone = "info",
  title,
  children,
}: {
  tone?: "info" | "warning";
  title?: string;
  children: ReactNode;
}) {
  const tones = {
    info: "border-info-border bg-info-bg text-info",
    warning: "border-warning-border bg-warning-bg text-warning",
  } as const;

  return (
    <div className={clsx("rounded-md border px-4 py-3 text-sm", tones[tone])}>
      {title ? <p className="font-medium">{title}</p> : null}
      <div className={clsx(title && "mt-1", "leading-relaxed")}>{children}</div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Inline code, used inside notices                                            */
/* -------------------------------------------------------------------------- */

/**
 * Notices are tinted, so a plain `bg-card` chip would look pasted on. A
 * translucent black/white wash tracks whatever surface it sits on.
 */
export const codeChipClass =
  "rounded bg-foreground/5 px-1 py-0.5 font-mono text-xs dark:bg-foreground/10";
