import { redirect } from "next/navigation";
import type { User } from "@prisma/client";

import { AppShell } from "@/components/layout/AppShell";
import { AuthRequiredError, getCurrentUser } from "@/lib/session";

// Every page in this segment reads live database state.
export const dynamic = "force-dynamic";

/**
 * The gate for every signed-in page.
 *
 * The middleware already turns a request with no session cookie into a
 * redirect, but it runs on the Edge and cannot check the database — so a
 * cookie holding an expired, revoked or invented token reaches here looking
 * plausible. getCurrentUser() resolves it against the Session table and
 * throws when it does not correspond to a live session, and that is the check
 * that actually decides. Two layers, and the authoritative one is this.
 */
export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  let user: User;
  try {
    user = await getCurrentUser();
  } catch (error) {
    if (error instanceof AuthRequiredError) redirect("/login");
    throw error;
  }

  return (
    <AppShell
      workspaceName={user.name ?? user.email}
      workspaceEmail={user.email}
    >
      {children}
    </AppShell>
  );
}
