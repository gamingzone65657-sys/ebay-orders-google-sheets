"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

import { OAUTH_POPUP_MESSAGE } from "@/lib/ebay/oauth-state";

/**
 * Reports the outcome of a consent popup to the tab that opened it, then
 * closes the popup.
 *
 * `window.close()` is only permitted on a window that script opened, which is
 * exactly this one — but it still fails if the seller reached this URL some
 * other way (a bookmark, a reload in the wrong window, a browser that ignores
 * the request). So the close is attempted and the page also renders a
 * readable outcome, rather than assuming it will vanish.
 *
 * The message is posted to the opener's own origin, never "*": the opener is
 * this application, and a wildcard would hand the result to whatever site
 * happened to be there instead.
 */
export function OauthPopupCloser() {
  const params = useSearchParams();
  const errorCode = params.get("ebay_error");
  const detail = params.get("detail");
  const connected = params.get("ebay") === "connected";

  const [closing, setClosing] = useState(true);

  useEffect(() => {
    const opener = window.opener as Window | null;
    if (opener && !opener.closed) {
      try {
        opener.postMessage(
          {
            type: OAUTH_POPUP_MESSAGE,
            connected,
            errorCode,
            detail,
          },
          window.location.origin,
        );
      } catch {
        // A cross-origin opener cannot be messaged. The seller still sees the
        // outcome here, and the settings page picks it up on its next load.
      }
    }

    // A beat, so the message is delivered before the window goes away and so
    // the seller sees that something succeeded rather than a window blinking.
    const timer = window.setTimeout(() => {
      window.close();
      // Still here means the browser refused to close it.
      setClosing(false);
    }, 600);

    return () => window.clearTimeout(timer);
  }, [connected, errorCode, detail]);

  return (
    <div className="max-w-sm space-y-2">
      <p className="text-base font-medium text-foreground">
        {connected ? "Connected to eBay" : "Could not connect to eBay"}
      </p>
      {detail ? (
        <p className="text-sm text-muted-foreground break-words">{detail}</p>
      ) : null}
      <p className="text-sm text-muted-foreground">
        {closing
          ? "Closing this window…"
          : "You can close this window and return to the application."}
      </p>
    </div>
  );
}
