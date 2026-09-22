"use client";

import { useState } from "react";

import { FeedbackBanner } from "@/components/FeedbackBanner";
import { Button } from "@/components/ui/Button";
import { Field, inputClass, selectClass } from "@/components/ui/primitives";
import { useApiAction } from "@/components/useApiAction";

const TIMEZONES = [
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Los_Angeles",
  "Europe/London",
  "Europe/Berlin",
  "Australia/Sydney",
];

/* -------------------------------------------------------------------------- */
/* Profile                                                                     */
/* -------------------------------------------------------------------------- */

export function ProfileForm({
  initialName,
  initialTimezone,
  email,
}: {
  initialName: string;
  initialTimezone: string;
  email: string;
}) {
  const { run, pending, feedback } = useApiAction();
  const [name, setName] = useState(initialName);
  const [timezone, setTimezone] = useState(initialTimezone);

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        run(
          "profile",
          {
            url: "/api/settings",
            method: "PUT",
            body: { profile: { name, timezone } },
          },
          { successMessage: "Profile saved." },
        );
      }}
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Field label="Display name" htmlFor="profile-name">
          <input
            id="profile-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            className={inputClass}
          />
        </Field>
        <Field
          label="Email"
          htmlFor="profile-email"
          hint="Editable once sign-in exists."
        >
          <input
            id="profile-email"
            value={email}
            disabled
            className={inputClass}
          />
        </Field>
        <Field label="Timezone" htmlFor="profile-timezone">
          <select
            id="profile-timezone"
            value={timezone}
            onChange={(event) => setTimezone(event.target.value)}
            className={selectClass}
          >
            {TIMEZONES.map((tz) => (
              <option key={tz} value={tz}>
                {tz}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <FeedbackBanner feedback={feedback} />
      <Button type="submit" variant="primary" disabled={pending !== null}>
        {pending === "profile" ? "Saving…" : "Save profile"}
      </Button>
    </form>
  );
}

/* -------------------------------------------------------------------------- */
/* Sync preferences                                                            */
/* -------------------------------------------------------------------------- */

export function SyncPreferencesForm({
  initial,
}: {
  initial: Record<string, string>;
}) {
  const { run, pending, feedback } = useApiAction();
  const [form, setForm] = useState({
    batchSize: initial["sync.batchSize"] ?? "50",
    skipCancelled: (initial["sync.skipCancelled"] ?? "true") === "true",
    skipUnpaid: (initial["sync.skipUnpaid"] ?? "true") === "true",
    dateFormat: initial["ui.dateFormat"] ?? "yyyy-MM-dd",
  });

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        run(
          "sync-prefs",
          {
            url: "/api/settings",
            method: "PUT",
            body: {
              preferences: {
                "sync.batchSize": form.batchSize,
                "sync.skipCancelled": String(form.skipCancelled),
                "sync.skipUnpaid": String(form.skipUnpaid),
                "ui.dateFormat": form.dateFormat,
              },
            },
          },
          { successMessage: "Sync preferences saved." },
        );
      }}
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field
          label="Orders per batch"
          htmlFor="batch-size"
          hint="How many orders one sync page requests from eBay."
        >
          <input
            id="batch-size"
            type="number"
            min={10}
            max={200}
            value={form.batchSize}
            onChange={(event) =>
              setForm({ ...form, batchSize: event.target.value })
            }
            className={inputClass}
          />
        </Field>
        <Field
          label="Default date format"
          htmlFor="date-format"
          hint="Offered as the default when you add a date transformation."
        >
          <select
            id="date-format"
            value={form.dateFormat}
            onChange={(event) =>
              setForm({ ...form, dateFormat: event.target.value })
            }
            className={selectClass}
          >
            <option value="yyyy-MM-dd">yyyy-MM-dd</option>
            <option value="MM/dd/yyyy">MM/dd/yyyy</option>
            <option value="dd/MM/yyyy">dd/MM/yyyy</option>
            <option value="yyyy-MM-dd HH:mm">yyyy-MM-dd HH:mm</option>
          </select>
        </Field>
      </div>

      <div className="space-y-2">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.skipCancelled}
            onChange={(event) =>
              setForm({ ...form, skipCancelled: event.target.checked })
            }
            className="h-4 w-4 rounded border-input accent-[var(--primary)]"
          />
          <span className="text-foreground">Skip cancelled orders</span>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.skipUnpaid}
            onChange={(event) =>
              setForm({ ...form, skipUnpaid: event.target.checked })
            }
            className="h-4 w-4 rounded border-input accent-[var(--primary)]"
          />
          <span className="text-foreground">
            Skip orders whose payment has not completed
          </span>
        </label>
      </div>

      <FeedbackBanner feedback={feedback} />
      <Button type="submit" variant="primary" disabled={pending !== null}>
        {pending === "sync-prefs" ? "Saving…" : "Save sync preferences"}
      </Button>
    </form>
  );
}

/* -------------------------------------------------------------------------- */
/* Security preferences                                                        */
/* -------------------------------------------------------------------------- */

export function SecurityPreferencesForm({
  initial,
}: {
  initial: Record<string, string>;
}) {
  const { run, pending, feedback } = useApiAction();
  const [auditLogging, setAuditLogging] = useState(
    (initial["security.auditLogging"] ?? "true") === "true",
  );

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        run(
          "security",
          {
            url: "/api/settings",
            method: "PUT",
            body: {
              preferences: {
                "security.auditLogging": String(auditLogging),
              },
            },
          },
          { successMessage: "Security preferences saved." },
        );
      }}
    >
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={auditLogging}
          onChange={(event) => setAuditLogging(event.target.checked)}
          className="mt-0.5 h-4 w-4 rounded border-input accent-[var(--primary)]"
        />
        <span>
          <span className="block text-foreground">
            Keep a detailed log of every sync step
          </span>
          <span className="block text-xs text-muted-foreground">
            Turning this off records only the run summary, not per-step entries.
          </span>
        </span>
      </label>

      <FeedbackBanner feedback={feedback} />
      <Button type="submit" variant="primary" disabled={pending !== null}>
        {pending === "security" ? "Saving…" : "Save security preferences"}
      </Button>
    </form>
  );
}
