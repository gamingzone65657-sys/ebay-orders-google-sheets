import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { AuthForm } from "@/components/auth/AuthForm";
import { registrationOpen } from "@/lib/registration";
import { getSessionUser } from "@/lib/session";

export const metadata: Metadata = { title: "Sign in" };
export const dynamic = "force-dynamic";

/**
 * Outside the (app) route group, so it renders without a workspace to label.
 */
export default async function LoginPage() {
  // getSessionUser, not getCurrentUser: this must show the form even in local
  // development, where getCurrentUser() resolves an anonymous request to the
  // owner and would bounce straight back to the dashboard.
  if (await getSessionUser()) redirect("/dashboard");

  return (
    <Suspense fallback={null}>
      <AuthForm mode="login" registrationOpen={registrationOpen()} />
    </Suspense>
  );
}
