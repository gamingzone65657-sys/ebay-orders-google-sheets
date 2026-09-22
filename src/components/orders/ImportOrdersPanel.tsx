"use client";

import { useState } from "react";
import { Download } from "lucide-react";

import { FeedbackBanner } from "@/components/FeedbackBanner";
import { Button, ButtonLink } from "@/components/ui/Button";
import { selectClass } from "@/components/ui/primitives";
import { useApiAction } from "@/components/useApiAction";

const WINDOWS = [
  { value: 1, label: "Last 24 hours" },
  { value: 7, label: "Last 7 days" },
  { value: 30, label: "Last 30 days" },
  { value: 90, label: "Last 90 days" },
  { value: 180, label: "Last 6 months" },
  { value: 365, label: "Last 12 months" },
];

interface ImportResponse {
  status?: string;
  imported?: number;
  updated?: number;
  skipped?: number;
  errors?: number;
  pages?: number;
  apiCalls?: number;
  reportedTotal?: number | null;
  truncated?: boolean;
  errorMessage?: string;
  summary?: string;
}

export function ImportOrdersPanel({
  canImport,
  disabledReason,
}: {
  canImport: boolean;
  disabledReason: string | null;
}) {
  const { run, pending, feedback, setFeedback } = useApiAction();
  const [lookbackDays, setLookbackDays] = useState(30);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={lookbackDays}
          onChange={(event) => setLookbackDays(Number(event.target.value))}
          className={`${selectClass} w-44`}
          aria-label="Import window"
          disabled={!canImport || pending !== null}
        >
          {WINDOWS.map((window) => (
            <option key={window.value} value={window.value}>
              {window.label}
            </option>
          ))}
        </select>

        <Button
          variant="primary"
          disabled={!canImport || pending !== null}
          onClick={async () => {
            const result = await run(
              "import",
              { url: "/api/ebay/import", body: { lookbackDays } },
              { refresh: true },
            );
            const data = (result.data ?? {}) as ImportResponse;

            if (!result.ok) return;

            if (data.status === "FAILED") {
              setFeedback({
                tone: "error",
                message:
                  data.errorMessage ??
                  data.summary ??
                  "The import could not run.",
              });
              return;
            }

            const parts = [
              `${data.imported ?? 0} imported`,
              `${data.updated ?? 0} updated`,
              `${data.skipped ?? 0} skipped`,
              `${data.errors ?? 0} error(s)`,
            ];
            const detail = `${parts.join(", ")} across ${
              data.pages ?? 0
            } page(s) and ${data.apiCalls ?? 0} eBay API call(s).`;

            setFeedback({
              tone: data.status === "PARTIAL" ? "error" : "success",
              message: data.truncated
                ? `${detail} The page guard stopped the walk early — narrow the window to import the rest.`
                : detail,
            });
          }}
        >
          <Download className="h-4 w-4" />
          {pending === "import" ? "Importing…" : "Import from eBay"}
        </Button>

        {!canImport ? (
          <ButtonLink href="/settings#ebay">Connect eBay</ButtonLink>
        ) : null}
      </div>

      {!canImport && disabledReason ? (
        <p className="text-sm text-muted-foreground">{disabledReason}</p>
      ) : null}

      <FeedbackBanner feedback={feedback} />
    </div>
  );
}
