"use client";

import { useState } from "react";
import { ExternalLink, Plug, RefreshCw, Unplug } from "lucide-react";

import { FeedbackBanner } from "@/components/FeedbackBanner";
import { Button } from "@/components/ui/Button";
import { Field, selectClass } from "@/components/ui/primitives";
import { useApiAction } from "@/components/useApiAction";

export interface EbayPanelProps {
  configured: boolean;
  /** True when this runs on a hosting platform, where there is no .env. */
  hosted?: boolean;
  missingVars: string[];
  status: string;
  environment: string;
  marketplaceId: string;
  marketplaces: { id: string; label: string }[];
  defaultEnvironment: string;
}

interface TestResponse {
  reachable?: boolean;
  message?: string;
  detail?: string;
  code?: string;
}

export function EbayConnectionPanel({
  configured,
  hosted = false,
  missingVars,
  status,
  environment,
  marketplaceId,
  marketplaces,
  defaultEnvironment,
}: EbayPanelProps) {
  const { run, pending, feedback, setFeedback } = useApiAction();
  const [form, setForm] = useState({
    environment: environment || defaultEnvironment,
    marketplaceId: marketplaceId || "EBAY_US",
  });
  const [navigating, setNavigating] = useState(false);

  const connected = status !== "DISCONNECTED";
  const isLive = status === "CONNECTED" || status === "EXPIRED";

  // Consent has to be a full-page navigation: the seller signs in on eBay's
  // own domain. A fetch would be blocked and would also be the wrong UX.
  const startOauth = () => {
    setNavigating(true);
    const params = new URLSearchParams({
      environment: form.environment,
      marketplaceId: form.marketplaceId,
    });
    window.location.href = `/api/auth/ebay/start?${params}`;
  };

  const busy = pending !== null || navigating;

  return (
    <div className="space-y-4">
      {!configured ? (
        <div className="rounded-md border border-warning-border bg-warning-bg px-4 py-3 text-sm text-warning">
          <p className="font-medium">eBay credentials are not configured</p>
          <p className="mt-1">
            Set{" "}
            <code className="rounded bg-foreground/10 px-1 py-0.5 font-mono text-xs">
              {missingVars.join(", ")}
            </code>{" "}
            {hosted
              ? "in your hosting provider's environment variables, then redeploy — a deployment only picks up variables that existed when it was created."
              : "in .env and restart the server."}{" "}
            The values come from your eBay developer account; the RuName
            must point its redirect at{" "}
            <code className="font-mono text-xs">/api/auth/ebay/callback</code>.
          </p>
        </div>
      ) : null}

      {configured && !isLive ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field
            label="Environment"
            htmlFor="ebay-environment"
            hint="Must match the keyset the credentials came from."
          >
            <select
              id="ebay-environment"
              value={form.environment}
              onChange={(event) =>
                setForm({ ...form, environment: event.target.value })
              }
              className={selectClass}
              disabled={busy}
            >
              <option value="SANDBOX">Sandbox</option>
              <option value="PRODUCTION">Production</option>
            </select>
          </Field>

          <Field label="Marketplace" htmlFor="ebay-marketplace">
            <select
              id="ebay-marketplace"
              value={form.marketplaceId}
              onChange={(event) =>
                setForm({ ...form, marketplaceId: event.target.value })
              }
              className={selectClass}
              disabled={busy}
            >
              {marketplaces.map((marketplace) => (
                <option key={marketplace.id} value={marketplace.id}>
                  {marketplace.label} ({marketplace.id})
                </option>
              ))}
            </select>
          </Field>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {configured ? (
          <Button variant="primary" onClick={startOauth} disabled={busy}>
            <Plug className="h-4 w-4" />
            {navigating
              ? "Redirecting to eBay…"
              : isLive
                ? "Reconnect eBay"
                : "Connect eBay"}
            <ExternalLink className="h-3.5 w-3.5 opacity-70" />
          </Button>
        ) : null}

        {isLive ? (
          <Button
            disabled={busy}
            onClick={async () => {
              const result = await run("test", { url: "/api/ebay/test" });
              const data = (result.data ?? {}) as TestResponse;
              setFeedback({
                tone: data.reachable ? "success" : "error",
                message: data.detail
                  ? `${data.message ?? "eBay request failed."} (${data.detail})`
                  : (data.message ?? "eBay request failed."),
              });
            }}
          >
            <RefreshCw className="h-4 w-4" />
            {pending === "test" ? "Testing…" : "Test connection"}
          </Button>
        ) : null}

        {connected ? (
          <Button
            variant="danger"
            disabled={busy}
            onClick={() =>
              run(
                "disconnect",
                {
                  url: "/api/connections/ebay",
                  body: { action: "disconnect" },
                },
                {
                  successMessage:
                    "eBay disconnected and stored tokens deleted. Imported orders were kept.",
                },
              )
            }
          >
            <Unplug className="h-4 w-4" />
            {pending === "disconnect" ? "Disconnecting…" : "Disconnect eBay"}
          </Button>
        ) : null}


      </div>


      <p className="text-xs text-muted-foreground">
        Connecting opens eBay&apos;s own sign-in and consent page. This
        application never sees your eBay password, and the access and refresh
        tokens are encrypted before they are stored.
      </p>

      <FeedbackBanner feedback={feedback} />
    </div>
  );
}
