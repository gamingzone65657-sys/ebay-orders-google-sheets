import { AppShell } from "@/components/layout/AppShell";
import { AuthRequiredError, getCurrentUser } from "@/lib/session";
import type { User } from "@prisma/client";

// Every page in this segment reads live database state.
export const dynamic = "force-dynamic";

/**
 * Shown when the deployment has no way to identify who is asking.
 *
 * This is a configuration problem, not a fault, so it gets a page that says
 * what to do rather than a stack trace or a blank 500. It is also the one
 * screen that must render without a user, so it deliberately sits outside
 * AppShell — the shell needs a workspace to label.
 */
function AuthNotConfigured({ message }: { message: string }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl items-center px-6">
      <div className="w-full rounded-lg border border-warning-border bg-warning-bg p-6">
        <h1 className="text-lg font-semibold text-warning">
          Authentication is not configured
        </h1>
        <p className="mt-3 text-sm text-foreground">{message}</p>
        <p className="mt-4 text-sm text-muted-foreground">
          This application has no sign-in screen yet. In production it refuses
          every request rather than serving one workspace to anyone who can
          reach the server.
        </p>
        <p className="mt-3 text-sm text-muted-foreground">
          If this instance is reachable only by you — bound to localhost,
          behind a VPN, or behind a proxy that authenticates — set{" "}
          <code className="rounded bg-foreground/10 px-1 py-0.5 font-mono text-xs">
            SINGLE_USER_MODE=true
          </code>{" "}
          and restart. Otherwise add real authentication before exposing it.
        </p>
      </div>
    </main>
  );
}

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  let user: User;
  try {
    user = await getCurrentUser();
  } catch (error) {
    if (error instanceof AuthRequiredError) {
      return <AuthNotConfigured message={error.message} />;
    }
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
