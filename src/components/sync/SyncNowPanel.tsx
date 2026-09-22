"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, CheckCircle2, Play, RefreshCw, XCircle } from "lucide-react";

import { Button, ButtonLink } from "@/components/ui/Button";
import { Badge, inputClass, selectClass } from "@/components/ui/primitives";
import {
  ROW_MODES,
  SYNC_MODES,
  SYNC_MODE_DESCRIPTIONS,
  SYNC_RANGES,
  SYNC_RANGE_LABELS,
  type RowMode,
  type SyncMode,
  type SyncRange,
} from "@/lib/constants";
import { fetchJson, type ApiFailure } from "@/lib/fetch-json";

/** One line carrying the server's own wording, its code, and the status. */
function describe(failure: ApiFailure, fallback: string): string {
  const parts = [failure.message || fallback];
  if (failure.code) parts.push(failure.code);
  if (failure.status) parts.push(`HTTP ${failure.status}`);
  if (failure.detail) parts.push(failure.detail);
  return parts.join(" · ");
}

interface PreviewData {
  spreadsheetName: string;
  sheetName: string;
  rowMode: string;
  syncMode: string;
  ordersFound: number;
  ordersNew: number;
  ordersExisting: number;
  rowsToInsert: number;
  rowsToUpdate: number;
  rowsUnchanged: number;
  rowsSkippedByMode: number;
  fieldsWritten: { header: string; letter: string; sourceField: string }[];
  blockers: string[];
  warnings: string[];
  confirmationRequired: boolean;
  sample: { rowKey: string; action: string; targetRow: number | null; values: string[] }[];
}

interface JobStatus {
  jobId: string;
  status: string;
  phase: string;
  phaseLabel: string;
  done: boolean;
  progress: { current: number; total: number; label: string | null };
  results: {
    found: number;
    inserted: number;
    updated: number;
    skipped: number;
    failed: number;
  };
  summary: string | null;
  errorMessage: string | null;
  logs: { level: string; step: string; message: string }[];
}

export function SyncNowPanel({
  hasDestination,
  defaultRowMode,
  defaultSyncMode,
  alreadyConfirmed,
}: {
  hasDestination: boolean;
  defaultRowMode: string;
  defaultSyncMode: string;
  alreadyConfirmed: boolean;
}) {
  const router = useRouter();

  const [range, setRange] = useState<SyncRange>(SYNC_RANGES.SINCE_LAST);
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [rowMode, setRowMode] = useState<RowMode>(defaultRowMode as RowMode);
  const [syncMode, setSyncMode] = useState<SyncMode>(defaultSyncMode as SyncMode);

  const [busy, setBusy] = useState<"preview" | "run" | null>(null);
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [job, setJob] = useState<JobStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
  }, []);

  const body = () => ({
    range,
    rowMode,
    syncMode,
    ...(range === SYNC_RANGES.CUSTOM
      ? {
          customFrom: customFrom
            ? new Date(`${customFrom}T00:00:00.000Z`).toISOString()
            : undefined,
          customTo: customTo
            ? new Date(`${customTo}T23:59:59.999Z`).toISOString()
            : undefined,
        }
      : {}),
  });

  const customIncomplete =
    range === SYNC_RANGES.CUSTOM && (!customFrom || !customTo);

  const runPreview = async () => {
    setBusy("preview");
    setError(null);
    setJob(null);
    const response = await fetchJson<PreviewData>("/api/sync/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body()),
    });

    if (!response.ok) {
      setError(describe(response.error, "The preview could not be built."));
      setPreview(null);
    } else {
      setPreview(response.data);
    }
    setBusy(null);
  };

  const poll = async (jobId: string) => {
    const response = await fetchJson<JobStatus>(`/api/sync/jobs/${jobId}`);
    if (!response.ok) {
      setError(describe(response.error, "Lost track of the sync job."));
      setBusy(null);
      return;
    }

    const status = response.data;
    setJob(status);

    if (!status.done) {
      pollTimer.current = setTimeout(() => void poll(jobId), 900);
      return;
    }

    setBusy(null);
    setPreview(null);
    router.refresh();
  };

  const runSync = async (confirmed: boolean) => {
    setBusy("run");
    setError(null);

    const response = await fetchJson<{ jobId: string }>("/api/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body(), confirmed }),
    });

    if (!response.ok) {
      setError(describe(response.error, "The sync could not be started."));
      setBusy(null);
      return;
    }
    void poll(response.data.jobId);
  };

  const needsConfirmation =
    preview?.confirmationRequired ?? !alreadyConfirmed;
  const blocked = (preview?.blockers.length ?? 0) > 0;

  return (
    <div className="space-y-4">
      {/* --- Options -------------------------------------------------- */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-foreground">
            Date range
          </span>
          <select
            value={range}
            onChange={(event) => setRange(event.target.value as SyncRange)}
            className={selectClass}
            disabled={busy !== null}
          >
            {Object.values(SYNC_RANGES).map((value) => (
              <option key={value} value={value}>
                {SYNC_RANGE_LABELS[value]}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-foreground">
            Rows
          </span>
          <select
            value={rowMode}
            onChange={(event) => setRowMode(event.target.value as RowMode)}
            className={selectClass}
            disabled={busy !== null}
          >
            <option value={ROW_MODES.ORDER}>One row per order</option>
            <option value={ROW_MODES.LINE_ITEM}>One row per line item</option>
          </select>
        </label>

        <label className="block sm:col-span-2">
          <span className="mb-1.5 block text-xs font-medium text-foreground">
            Sync mode
          </span>
          <select
            value={syncMode}
            onChange={(event) => setSyncMode(event.target.value as SyncMode)}
            className={selectClass}
            disabled={busy !== null}
          >
            <option value={SYNC_MODES.APPEND_UPDATE}>Append + update</option>
            <option value={SYNC_MODES.APPEND}>Append new orders only</option>
            <option value={SYNC_MODES.UPDATE}>Update existing orders only</option>
          </select>
          <span className="mt-1 block text-xs text-muted-foreground">
            {SYNC_MODE_DESCRIPTIONS[syncMode]}
          </span>
        </label>
      </div>

      {range === SYNC_RANGES.CUSTOM ? (
        <div className="flex flex-wrap gap-3">
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-foreground">
              From
            </span>
            <input
              type="date"
              value={customFrom}
              onChange={(event) => setCustomFrom(event.target.value)}
              className={`${inputClass} w-44`}
              disabled={busy !== null}
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-foreground">
              To
            </span>
            <input
              type="date"
              value={customTo}
              onChange={(event) => setCustomTo(event.target.value)}
              className={`${inputClass} w-44`}
              disabled={busy !== null}
            />
          </label>
        </div>
      ) : null}

      {/* --- Actions -------------------------------------------------- */}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          onClick={() => void runPreview()}
          disabled={!hasDestination || busy !== null || customIncomplete}
        >
          <RefreshCw className="h-4 w-4" />
          {busy === "preview" ? "Building preview…" : "Preview sync"}
        </Button>

        <Button
          variant="primary"
          onClick={() => void runSync(!needsConfirmation)}
          disabled={
            !hasDestination ||
            busy !== null ||
            customIncomplete ||
            blocked ||
            (needsConfirmation && !preview)
          }
        >
          <Play className="h-4 w-4" />
          {busy === "run" ? "Syncing…" : "Sync Now"}
        </Button>

        {!hasDestination ? (
          <ButtonLink href="/google-sheet">Choose a destination</ButtonLink>
        ) : null}
      </div>

      {!hasDestination ? (
        <p className="text-sm text-muted-foreground">
          Select a spreadsheet and worksheet before syncing.
        </p>
      ) : needsConfirmation && !preview ? (
        <p className="text-sm text-warning">
          This is the first bulk sync into this sheet — run a preview and
          confirm before anything is written.
        </p>
      ) : null}

      {error ? (
        <div className="rounded-md border border-danger-border bg-danger-bg px-4 py-3 text-sm text-danger">
          {error}
        </div>
      ) : null}

      {/* --- Preview -------------------------------------------------- */}
      {preview && !job ? (
        <div className="rounded-md border border-border bg-muted p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-foreground">
              Preview — nothing has been written
            </h3>
            <Badge tone={blocked ? "danger" : "info"}>
              {preview.spreadsheetName} / {preview.sheetName}
            </Badge>
          </div>

          <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {[
              ["Orders found", preview.ordersFound],
              ["New orders", preview.ordersNew],
              ["Existing orders", preview.ordersExisting],
              ["Rows to insert", preview.rowsToInsert],
              ["Rows to update", preview.rowsToUpdate],
              ["Unchanged", preview.rowsUnchanged],
            ].map(([label, value]) => (
              <div
                key={String(label)}
                className="rounded border border-border bg-card px-3 py-2"
              >
                <dt className="text-xs text-muted-foreground">{label}</dt>
                <dd className="text-lg font-semibold tabular-nums text-foreground">
                  {value}
                </dd>
              </div>
            ))}
          </dl>

          {preview.rowsSkippedByMode > 0 ? (
            <p className="mt-2 text-xs text-muted-foreground">
              {preview.rowsSkippedByMode} row(s) skipped by the current sync
              mode.
            </p>
          ) : null}

          <div className="mt-3">
            <p className="text-xs font-medium text-foreground">
              Fields that will be written ({preview.fieldsWritten.length})
            </p>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {preview.fieldsWritten.map((field) => (
                <span
                  key={field.header}
                  className="rounded bg-card px-2 py-1 text-xs text-foreground ring-1 ring-border ring-inset"
                  title={field.sourceField}
                >
                  <span className="font-mono text-muted-foreground">{field.letter}</span>{" "}
                  {field.header}
                </span>
              ))}
            </div>
            <p className="mt-1.5 text-xs text-muted-foreground">
              No other column is touched.
            </p>
          </div>

          {preview.blockers.map((blocker) => (
            <p
              key={blocker}
              className="mt-2 flex items-start gap-2 rounded border border-danger-border bg-danger-bg px-3 py-2 text-sm text-danger"
            >
              <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
              {blocker}
            </p>
          ))}
          {preview.warnings.slice(0, 4).map((warning) => (
            <p
              key={warning}
              className="mt-2 flex items-start gap-2 rounded border border-warning-border bg-warning-bg px-3 py-2 text-sm text-warning"
            >
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              {warning}
            </p>
          ))}

          {preview.confirmationRequired && !blocked ? (
            <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
              <span className="text-sm text-foreground">
                Confirm to write {preview.rowsToInsert + preview.rowsToUpdate}{" "}
                row(s) into {preview.sheetName}.
              </span>
              <Button
                variant="primary"
                onClick={() => void runSync(true)}
                disabled={busy !== null}
              >
                Confirm and sync
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* --- Progress + results ---------------------------------------- */}
      {job ? (
        <div
          className={`rounded-md border p-4 ${
            job.done
              ? job.results.failed > 0
                ? "border-warning-border bg-warning-bg"
                : "border-success-border bg-success-bg"
              : "border-info-border bg-info-bg"
          }`}
        >
          <div className="flex items-center gap-2">
            {job.done ? (
              job.results.failed > 0 ? (
                <AlertTriangle className="h-4 w-4 text-warning" />
              ) : (
                <CheckCircle2 className="h-4 w-4 text-success" />
              )
            ) : (
              <RefreshCw className="h-4 w-4 animate-spin text-info" />
            )}
            <p className="text-sm font-medium text-foreground">
              {job.phaseLabel}
            </p>
            {job.progress.total > 0 && !job.done ? (
              <span className="text-xs text-muted-foreground">
                {job.progress.current} / {job.progress.total} rows
              </span>
            ) : null}
          </div>

          {job.progress.total > 0 ? (
            <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-foreground/10">
              <div
                className="h-full bg-primary"
                style={{
                  width: `${Math.min(
                    100,
                    job.done
                      ? 100
                      : (job.progress.current / Math.max(1, job.progress.total)) *
                          100,
                  )}%`,
                }}
              />
            </div>
          ) : null}

          {job.done ? (
            <>
              <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-5">
                {[
                  ["Found", job.results.found, ""],
                  ["Inserted", job.results.inserted, "text-success"],
                  ["Updated", job.results.updated, "text-info"],
                  ["Skipped", job.results.skipped, "text-muted-foreground"],
                  ["Failed", job.results.failed, "text-danger"],
                ].map(([label, value, tone]) => (
                  <div
                    key={String(label)}
                    className="rounded border border-border bg-card px-3 py-2"
                  >
                    <dt className="text-xs text-muted-foreground">{label}</dt>
                    <dd
                      className={`text-lg font-semibold tabular-nums ${tone as string}`}
                    >
                      {value}
                    </dd>
                  </div>
                ))}
              </dl>

              {job.errorMessage ? (
                <p className="mt-2 text-sm text-danger">{job.errorMessage}</p>
              ) : null}

              {job.logs.filter((entry) => entry.level === "ERROR").length > 0 ? (
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs font-medium text-foreground">
                    Failures (
                    {job.logs.filter((entry) => entry.level === "ERROR").length})
                  </summary>
                  <ul className="mt-1 space-y-1 text-xs text-danger">
                    {job.logs
                      .filter((entry) => entry.level === "ERROR")
                      .map((entry, index) => (
                        <li key={index}>{entry.message}</li>
                      ))}
                  </ul>
                </details>
              ) : null}

              <p className="mt-2 text-xs text-muted-foreground">
                <a
                  href={`/sync-history/${job.jobId}`}
                  className="text-info hover:underline"
                >
                  View the full run log
                </a>
              </p>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
