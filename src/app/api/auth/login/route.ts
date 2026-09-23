import { z } from "zod";

import { apiError, handle, ok, parseBody } from "@/lib/api";
import { createSession, sessionCookie, verifyPassword } from "@/lib/auth";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

const LoginBody = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});

/**
 * Exchanges an email and password for a session.
 *
 * Both failure modes — no such account, wrong password — return the same
 * message and the same status, so this endpoint cannot be used to discover
 * which addresses have accounts. The password is still verified against a
 * throwaway hash when the account does not exist, so the two paths take
 * comparable time and the answer cannot be read off the clock either.
 */
export async function POST(request: Request) {
  return handle(async () => {
    const { data, error } = await parseBody(request, LoginBody);
    if (error) return error;

    const user = await prisma.user.findUnique({ where: { email: data.email } });
    const matched = await verifyPassword(data.password, user?.passwordHash ?? null);

    if (!user || !matched) {
      return apiError({
        code: "INVALID_CREDENTIALS",
        message: "That email and password do not match an account.",
        status: 401,
      });
    }

    const { token, expiresAt } = await createSession(user.id, {
      userAgent: request.headers.get("user-agent"),
      ipAddress:
        request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    });

    const response = ok({
      user: { id: user.id, email: user.email, name: user.name },
    });
    response.cookies.set(
      sessionCookie(token, expiresAt, new URL(request.url).protocol === "https:"),
    );
    return response;
  });
}
