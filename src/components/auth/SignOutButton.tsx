"use client";

import { useState } from "react";
import { LogOut } from "lucide-react";

import { fetchJson } from "@/lib/fetch-json";

/**
 * Ends this browser's session.
 *
 * The redirect is a full navigation rather than router.push, for the same
 * reason the sign-in form uses one: every page is server-rendered against the
 * session cookie, and the client router's cached tree still holds the
 * signed-in render.
 */
export function SignOutButton() {
  const [pending, setPending] = useState(false);

  return (
    <button
      type="button"
      disabled={pending}
      onClick={async () => {
        setPending(true);
        await fetchJson("/api/auth/logout", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        window.location.href = "/login";
      }}
      className="mt-1 flex w-full items-center gap-1.5 rounded-md px-1 py-1 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-60"
    >
      <LogOut className="h-3 w-3" />
      {pending ? "Signing out…" : "Sign out"}
    </button>
  );
}
