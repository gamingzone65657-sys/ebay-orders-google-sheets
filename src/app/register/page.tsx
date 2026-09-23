import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { AuthForm } from "@/components/auth/AuthForm";
import { registrationOpen } from "@/lib/registration";
import { getSessionUser } from "@/lib/session";

export const metadata: Metadata = { title: "Create an account" };
export const dynamic = "force-dynamic";

export default async function RegisterPage() {
  if (await getSessionUser()) redirect("/dashboard");

  // The API refuses too; this only avoids showing a form that cannot work.
  if (!registrationOpen()) redirect("/login");

  return (
    <Suspense fallback={null}>
      <AuthForm mode="register" registrationOpen />
    </Suspense>
  );
}
