"use client";

import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";

import { fetchJson } from "@/lib/fetch-json";

export interface ActionFeedback {
  tone: "success" | "error";
  message: string;
}

interface RunOptions {
  successMessage?: string | ((data: unknown) => string);
  /** Re-render server components after the call succeeds. */
  refresh?: boolean;
}

/**
 * Small wrapper around fetch for the mutation buttons: tracks a pending flag,
 * surfaces a message, and refreshes server components on success.
 */
export function useApiAction() {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<ActionFeedback | null>(null);

  const run = useCallback(
    async (
      key: string,
      input: { url: string; method?: string; body?: unknown },
      options: RunOptions = {},
    ): Promise<{ ok: boolean; data: unknown }> => {
      setPending(key);
      setFeedback(null);
      try {
        const result = await fetchJson(input.url, {
          method: input.method ?? "POST",
          headers: { "Content-Type": "application/json" },
          body: input.body === undefined ? undefined : JSON.stringify(input.body),
        });

        if (!result.ok) {
          // Show what the server actually said — including when it answered
          // with an error page rather than JSON.
          setFeedback({
            tone: "error",
            message: result.error.detail
              ? `${result.error.message} (${result.error.detail})`
              : result.error.message,
          });
          return { ok: false, data: null };
        }

        if (options.successMessage) {
          setFeedback({
            tone: "success",
            message:
              typeof options.successMessage === "function"
                ? options.successMessage(result.data)
                : options.successMessage,
          });
        }
        if (options.refresh !== false) router.refresh();
        return { ok: true, data: result.data ?? null };
      } finally {
        setPending(null);
      }
    },
    [router],
  );

  return { run, pending, feedback, setFeedback };
}
