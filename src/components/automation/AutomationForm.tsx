"use client";

import { useState } from "react";

import { FeedbackBanner } from "@/components/FeedbackBanner";
import { Button } from "@/components/ui/Button";
import { Field, inputClass, selectClass } from "@/components/ui/primitives";
import { useApiAction } from "@/components/useApiAction";
import {
  FREQUENCY_PRESETS,
  MAX_INTERVAL_MINUTES,
  MIN_INTERVAL_MINUTES,
  ORDER_STATUSES,
  frequencyLabel,
} from "@/lib/constants";

export interface AutomationFormValues {
  enabled: boolean;
  intervalMinutes: number;
  timezone: string;
  lookbackDays: number;
  activeFromHour: number | null;
  activeToHour: number | null;
  orderStatusFilter: string | null;
  retryLimit: number;
  retryBackoffSecs: number;
  notifyOnError: boolean;
  notifyOnSuccess: boolean;
  notifyEmail: string | null;
}

const CUSTOM = "CUSTOM";

const TIMEZONES = [
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Los_Angeles",
  "Europe/London",
  "Europe/Berlin",
  "Australia/Sydney",
];

export function AutomationForm({ initial }: { initial: AutomationFormValues }) {
  const { run, pending, feedback } = useApiAction();
  const [isCustom, setCustom] = useState(
    () =>
      !FREQUENCY_PRESETS.some(
        (preset) => preset.minutes === initial.intervalMinutes,
      ),
  );
  const [form, setForm] = useState({
    ...initial,
    statuses: new Set(
      (initial.orderStatusFilter ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
    quietHours:
      initial.activeFromHour !== null && initial.activeToHour !== null,
    notifyEmail: initial.notifyEmail ?? "",
  });

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const toggleStatus = (status: string) => {
    const next = new Set(form.statuses);
    if (next.has(status)) next.delete(status);
    else next.add(status);
    set("statuses", next);
  };

  const submit = () => {
    run(
      "automation",
      {
        url: "/api/automation",
        method: "PUT",
        body: {
          enabled: form.enabled,
          intervalMinutes: Number(form.intervalMinutes),
          timezone: form.timezone,
          lookbackDays: Number(form.lookbackDays),
          activeFromHour: form.quietHours ? Number(form.activeFromHour ?? 0) : null,
          activeToHour: form.quietHours ? Number(form.activeToHour ?? 23) : null,
          orderStatusFilter:
            form.statuses.size > 0 ? [...form.statuses].join(",") : null,
          retryLimit: Number(form.retryLimit),
          retryBackoffSecs: Number(form.retryBackoffSecs),
          notifyOnError: form.notifyOnError,
          notifyOnSuccess: form.notifyOnSuccess,
          notifyEmail: form.notifyEmail || null,
        },
      },
      { successMessage: "Automation settings saved." },
    );
  };

  return (
    <form
      className="space-y-6"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <label className="flex items-start gap-3 rounded-md border border-border bg-muted px-4 py-3">
        <input
          type="checkbox"
          checked={form.enabled}
          onChange={(event) => set("enabled", event.target.checked)}
          className="mt-0.5 h-4 w-4 rounded border-input accent-[var(--primary)]"
        />
        <span>
          <span className="block text-sm font-medium text-foreground">
            Run syncs automatically
          </span>
          <span className="block text-sm text-muted-foreground">
            When off, orders only move when you press Sync Now.
          </span>
        </span>
      </label>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Field
          label="Frequency"
          htmlFor="interval"
          hint={
            isCustom
              ? `Runs ${frequencyLabel(form.intervalMinutes).toLowerCase()}.`
              : undefined
          }
        >
          <select
            id="interval"
            value={isCustom ? CUSTOM : String(form.intervalMinutes)}
            onChange={(event) => {
              if (event.target.value === CUSTOM) {
                setCustom(true);
                return;
              }
              setCustom(false);
              set("intervalMinutes", Number(event.target.value));
            }}
            className={selectClass}
          >
            {FREQUENCY_PRESETS.map((preset) => (
              <option key={preset.minutes} value={String(preset.minutes)}>
                {preset.label}
              </option>
            ))}
            <option value={CUSTOM}>Custom interval…</option>
          </select>

          {isCustom ? (
            <div className="mt-2 flex items-center gap-2">
              <input
                type="number"
                min={MIN_INTERVAL_MINUTES}
                max={MAX_INTERVAL_MINUTES}
                value={form.intervalMinutes}
                onChange={(event) =>
                  set("intervalMinutes", Number(event.target.value))
                }
                className={`${inputClass} w-28`}
                aria-label="Custom interval in minutes"
              />
              <span className="text-sm text-muted-foreground">minutes</span>
            </div>
          ) : null}

          {isCustom &&
          (form.intervalMinutes < MIN_INTERVAL_MINUTES ||
            form.intervalMinutes > MAX_INTERVAL_MINUTES) ? (
            <p className="mt-1 text-xs text-danger">
              Must be between {MIN_INTERVAL_MINUTES} minutes and{" "}
              {MAX_INTERVAL_MINUTES / 1440} days.
            </p>
          ) : null}
        </Field>

        <Field label="Timezone" htmlFor="timezone">
          <select
            id="timezone"
            value={form.timezone}
            onChange={(event) => set("timezone", event.target.value)}
            className={selectClass}
          >
            {TIMEZONES.map((tz) => (
              <option key={tz} value={tz}>
                {tz}
              </option>
            ))}
          </select>
        </Field>

        <Field
          label="Look back"
          htmlFor="lookback"
          hint="How far back each run asks eBay for orders."
        >
          <div className="flex items-center gap-2">
            <input
              id="lookback"
              type="number"
              min={1}
              max={90}
              value={form.lookbackDays}
              onChange={(event) =>
                set("lookbackDays", Number(event.target.value))
              }
              className={inputClass}
            />
            <span className="text-sm text-muted-foreground">days</span>
          </div>
        </Field>
      </div>

      <div className="space-y-3 border-t border-border pt-5">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={form.quietHours}
            onChange={(event) => set("quietHours", event.target.checked)}
            className="h-4 w-4 rounded border-input accent-[var(--primary)]"
          />
          <span className="text-sm text-foreground">
            Only run between certain hours
          </span>
        </label>
        {form.quietHours ? (
          <div className="grid max-w-md grid-cols-2 gap-4">
            <Field label="From hour" htmlFor="from-hour">
              <input
                id="from-hour"
                type="number"
                min={0}
                max={23}
                value={form.activeFromHour ?? 0}
                onChange={(event) =>
                  set("activeFromHour", Number(event.target.value))
                }
                className={inputClass}
              />
            </Field>
            <Field label="To hour" htmlFor="to-hour">
              <input
                id="to-hour"
                type="number"
                min={0}
                max={23}
                value={form.activeToHour ?? 23}
                onChange={(event) =>
                  set("activeToHour", Number(event.target.value))
                }
                className={inputClass}
              />
            </Field>
          </div>
        ) : null}
      </div>

      <div className="border-t border-border pt-5">
        <p className="text-xs font-medium text-foreground">
          Only sync orders with these statuses
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Leave all unchecked to sync every order.
        </p>
        <div className="mt-2 flex flex-wrap gap-3">
          {ORDER_STATUSES.map((status) => (
            <label key={status} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.statuses.has(status)}
                onChange={() => toggleStatus(status)}
                className="h-4 w-4 rounded border-input accent-[var(--primary)]"
              />
              <span className="text-foreground">
                {status.charAt(0) + status.slice(1).toLowerCase()}
              </span>
            </label>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 border-t border-border pt-5 sm:grid-cols-2 lg:grid-cols-3">
        <Field
          label="Attempts per run"
          htmlFor="retry-limit"
          hint="Only transient failures are retried; a revoked token is not."
        >
          <input
            id="retry-limit"
            type="number"
            min={1}
            max={10}
            value={form.retryLimit}
            onChange={(event) => set("retryLimit", Number(event.target.value))}
            className={inputClass}
          />
        </Field>
        <Field label="Retry backoff (seconds)" htmlFor="retry-backoff">
          <input
            id="retry-backoff"
            type="number"
            min={5}
            max={3600}
            value={form.retryBackoffSecs}
            onChange={(event) =>
              set("retryBackoffSecs", Number(event.target.value))
            }
            className={inputClass}
          />
        </Field>
        <Field
          label="Notification email"
          htmlFor="notify-email"
          hint="Delivery is wired up in a later phase."
        >
          <input
            id="notify-email"
            type="email"
            value={form.notifyEmail}
            placeholder="alerts@example.com"
            onChange={(event) => set("notifyEmail", event.target.value)}
            className={inputClass}
          />
        </Field>
      </div>

      <div className="flex flex-wrap gap-4">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.notifyOnError}
            onChange={(event) => set("notifyOnError", event.target.checked)}
            className="h-4 w-4 rounded border-input accent-[var(--primary)]"
          />
          <span className="text-foreground">Notify on errors</span>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.notifyOnSuccess}
            onChange={(event) => set("notifyOnSuccess", event.target.checked)}
            className="h-4 w-4 rounded border-input accent-[var(--primary)]"
          />
          <span className="text-foreground">Notify on every successful run</span>
        </label>
      </div>

      <FeedbackBanner feedback={feedback} />

      <Button type="submit" variant="primary" disabled={pending !== null}>
        {pending === "automation" ? "Saving…" : "Save automation settings"}
      </Button>
    </form>
  );
}
