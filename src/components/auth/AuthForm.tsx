"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";

import { Button } from "@/components/ui/Button";
import { fetchJson } from "@/lib/fetch-json";

/** Only same-origin app paths may be resumed after signing in. */
function safeNext(value: string | null): string {
  if (!value) return "/dashboard";
  if (!value.startsWith("/") || value.startsWith("//")) return "/dashboard";
  return value;
}

const inputClass =
  "w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground " +
  "placeholder:text-muted-foreground focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent";

export function AuthForm({
  mode,
  registrationOpen,
}: {
  mode: "login" | "register";
  /** Only meaningful on the register page; hides the link when closed. */
  registrationOpen: boolean;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const next = safeNext(params.get("next"));

  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const isRegister = mode === "register";

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setPending(true);
    setError(null);

    const result = await fetchJson(
      isRegister ? "/api/auth/register" : "/api/auth/login",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          isRegister ? { email, name, password } : { email, password },
        ),
      },
    );

    if (!result.ok) {
      setError(result.error.message);
      setPending(false);
      return;
    }

    // A full navigation, not router.push: the session cookie was just set and
    // every page in the app is server-rendered against it, so the client
    // router's cached tree would otherwise be the signed-out one.
    window.location.href = next;
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-md items-center px-6">
      <div className="w-full">
        <h1 className="text-xl font-semibold text-foreground">
          {isRegister ? "Create an account" : "Sign in"}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {isRegister
            ? "Your workspace starts empty. Connect your own eBay and Google accounts after signing in."
            : "This workspace holds your connected eBay and Google accounts."}
        </p>

        <form onSubmit={submit} className="mt-6 space-y-4">
          <div>
            <label htmlFor="email" className="text-sm font-medium text-foreground">
              Email
            </label>
            <input
              id="email"
              type="email"
              required
              autoComplete="email"
              autoFocus
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className={`mt-1 ${inputClass}`}
            />
          </div>

          {isRegister ? (
            <div>
              <label htmlFor="name" className="text-sm font-medium text-foreground">
                Name <span className="text-muted-foreground">(optional)</span>
              </label>
              <input
                id="name"
                type="text"
                autoComplete="name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                className={`mt-1 ${inputClass}`}
              />
            </div>
          ) : null}

          <div>
            <label
              htmlFor="password"
              className="text-sm font-medium text-foreground"
            >
              Password
            </label>
            <input
              id="password"
              type="password"
              required
              autoComplete={isRegister ? "new-password" : "current-password"}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className={`mt-1 ${inputClass}`}
            />
            {isRegister ? (
              <p className="mt-1 text-xs text-muted-foreground">
                At least 12 characters. It protects the eBay and Google accounts
                you connect.
              </p>
            ) : null}
          </div>

          {error ? (
            <div
              role="alert"
              className="rounded-md border border-danger-border bg-danger-bg px-3 py-2 text-sm text-danger"
            >
              {error}
            </div>
          ) : null}

          <Button type="submit" variant="primary" disabled={pending} className="w-full">
            {pending
              ? isRegister
                ? "Creating account…"
                : "Signing in…"
              : isRegister
                ? "Create account"
                : "Sign in"}
          </Button>
        </form>

        {isRegister ? (
          <p className="mt-6 text-sm text-muted-foreground">
            Already have an account?{" "}
            <Link href="/login" className="text-accent hover:underline">
              Sign in
            </Link>
          </p>
        ) : registrationOpen ? (
          <p className="mt-6 text-sm text-muted-foreground">
            No account yet?{" "}
            <Link href="/register" className="text-accent hover:underline">
              Create one
            </Link>
          </p>
        ) : null}
      </div>
    </main>
  );
}
