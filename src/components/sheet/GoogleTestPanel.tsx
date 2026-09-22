"use client";

import { useState } from "react";
import { CheckCircle2, XCircle } from "lucide-react";

import { Button } from "@/components/ui/Button";
import { fetchJson } from "@/lib/fetch-json";

interface TestResult {
  target: string;
  ok: boolean;
  message: string;
  detail?: string;
  code?: string;
  facts?: Record<string, string | number | boolean | null>;
}

const TARGETS = [
  { id: "connection", label: "Test Google Connection" },
  { id: "spreadsheet", label: "Test Spreadsheet" },
  { id: "worksheet", label: "Test Worksheet" },
] as const;

export function GoogleTestPanel({
  hasSpreadsheet,
}: {
  hasSpreadsheet: boolean;
}) {
  const [pending, setPending] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, TestResult>>({});

  const runTest = async (target: string) => {
    setPending(target);
    const response = await fetchJson<TestResult>("/api/google/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target }),
    });

    const result: TestResult = response.ok
      ? response.data
      : {
          target,
          ok: false,
          message: response.error.message,
          detail: response.error.detail,
          code: response.error.code,
        };

    setResults((current) => ({ ...current, [target]: result }));
    setPending(null);
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {TARGETS.map((target) => (
          <Button
            key={target.id}
            disabled={
              pending !== null ||
              (target.id !== "connection" && !hasSpreadsheet)
            }
            onClick={() => void runTest(target.id)}
          >
            {pending === target.id ? "Testing…" : target.label}
          </Button>
        ))}
      </div>

      {!hasSpreadsheet ? (
        <p className="text-xs text-muted-foreground">
          Select a spreadsheet and worksheet to enable the last two tests.
        </p>
      ) : null}

      <div className="space-y-2">
        {TARGETS.map((target) => {
          const result = results[target.id];
          if (!result) return null;
          return (
            <div
              key={target.id}
              className={`rounded-md border px-3 py-2.5 text-sm ${
                result.ok
                  ? "border-success-border bg-success-bg text-success"
                  : "border-danger-border bg-danger-bg text-danger"
              }`}
            >
              <p className="flex items-start gap-2 font-medium">
                {result.ok ? (
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                ) : (
                  <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
                )}
                <span>
                  {target.label}: {result.ok ? "passed" : "failed"}
                </span>
              </p>
              <p className="mt-1 pl-6">{result.message}</p>
              {result.detail ? (
                <p className="mt-1 pl-6 font-mono text-xs break-words opacity-80">
                  {result.detail}
                </p>
              ) : null}
              {result.facts ? (
                <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 pl-6 sm:grid-cols-3">
                  {Object.entries(result.facts)
                    .filter(([, value]) => value !== null && value !== undefined)
                    .map(([key, value]) => (
                      <div key={key} className="min-w-0">
                        <dt className="text-xs opacity-70">{key}</dt>
                        <dd className="truncate text-xs font-medium">
                          {typeof value === "boolean"
                            ? value
                              ? "yes"
                              : "no"
                            : String(value)}
                        </dd>
                      </div>
                    ))}
                </dl>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
