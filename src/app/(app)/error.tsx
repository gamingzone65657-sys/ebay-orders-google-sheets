"use client";

import { useEffect } from "react";

import { Button } from "@/components/ui/Button";

/**
 * Segment-level error boundary: a failed query on any page renders here
 * instead of blanking the app.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[app]", error);
  }, [error]);

  return (
    <div className="mx-auto max-w-lg py-16 text-center">
      <h1 className="text-lg font-semibold text-foreground">
        Something went wrong on this page
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">
        {error.message || "An unexpected error occurred."}
      </p>
      <p className="mt-2 text-xs text-muted-foreground">
        If the database has not been created yet, run{" "}
        <code className="rounded bg-muted px-1 py-0.5 font-mono">
          npm run setup
        </code>
        .
      </p>
      <Button variant="primary" className="mt-4" onClick={reset}>
        Try again
      </Button>
    </div>
  );
}
