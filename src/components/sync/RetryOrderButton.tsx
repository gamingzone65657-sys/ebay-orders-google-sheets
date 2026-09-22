"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/Button";
import { fetchJson } from "@/lib/fetch-json";

/**
 * Retries one failed order.
 *
 * The result is shown next to the button rather than as a page-level banner,
 * because a failed-order table can have many of these and a shared banner
 * would not say which row it referred to.
 */
export function RetryOrderButton({
  orderId,
  ebayOrderId,
  disabled,
  disabledReason,
}: {
  orderId: string | null;
  ebayOrderId: string;
  disabled?: boolean;
  disabledReason?: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(
    null,
  );

  if (!orderId) {
    return (
      <span className="text-xs text-muted-foreground">
        Order no longer stored
      </span>
    );
  }

  const run = async () => {
    setPending(true);
    setResult(null);

    const response = await fetchJson<{ message: string }>(
      `/api/sync/orders/${encodeURIComponent(orderId)}/retry`,
      { method: "POST" },
    );

    if (response.ok) {
      setResult({ ok: true, message: response.data.message });
      // Bring the new run's records into the page.
      router.refresh();
    } else {
      setResult({ ok: false, message: response.error.message });
    }
    setPending(false);
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        size="sm"
        disabled={pending || disabled}
        onClick={() => void run()}
        title={disabled ? disabledReason : `Retry order ${ebayOrderId}`}
      >
        <RefreshCw className={`h-3.5 w-3.5 ${pending ? "animate-spin" : ""}`} />
        {pending ? "Retrying…" : "Retry"}
      </Button>
      {result ? (
        <span
          className={`max-w-[18rem] text-right text-xs ${
            result.ok ? "text-success" : "text-danger"
          }`}
        >
          {result.message}
        </span>
      ) : disabled && disabledReason ? (
        <span className="max-w-[18rem] text-right text-xs text-muted-foreground">
          {disabledReason}
        </span>
      ) : null}
    </div>
  );
}
