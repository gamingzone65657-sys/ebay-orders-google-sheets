import { Suspense } from "react";

import { OauthPopupCloser } from "@/components/settings/OauthPopupCloser";

export const dynamic = "force-dynamic";

/**
 * The last page a consent popup ever shows.
 *
 * It exists outside the (app) route group on purpose: the seller opened a
 * 600px window to sign in to eBay, and rendering the full application shell
 * inside it — sidebar, navigation, the lot — would be absurd. This renders
 * one line, tells the tab that opened it what happened, and closes.
 *
 * It is also deliberately not auth-gated. It carries no data: everything on
 * it arrives in the query string, and the connection was already saved by the
 * callback before the browser ever got here.
 */
export default function EbayOauthDonePage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-6 text-center">
      <Suspense fallback={null}>
        <OauthPopupCloser />
      </Suspense>
    </main>
  );
}
