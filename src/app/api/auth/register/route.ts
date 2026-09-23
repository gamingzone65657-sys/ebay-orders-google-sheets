import { Prisma } from "@prisma/client";
import { z } from "zod";

import { apiError, handle, ok, parseBody } from "@/lib/api";
import {
  createSession,
  hashPassword,
  passwordProblem,
  sessionCookie,
} from "@/lib/auth";
import { prisma } from "@/lib/db";
import { registrationOpen } from "@/lib/registration";

export const dynamic = "force-dynamic";

const RegisterBody = z.object({
  email: z.string().trim().toLowerCase().email(),
  name: z.string().trim().max(120).optional(),
  password: z.string(),
});

/**
 * Creates an account and its workspace, then signs the browser in.
 *
 * A workspace is not a separate row: every table that holds user data is
 * keyed by userId, so creating the user *is* creating an empty workspace. The
 * new account has no eBay connection, no Google connection, no spreadsheet
 * and no orders, and no query anywhere can reach another account's rows.
 */
export async function POST(request: Request) {
  return handle(async () => {
    if (!registrationOpen()) {
      return apiError({
        code: "REGISTRATION_CLOSED",
        message:
          "This deployment does not accept new accounts. Ask its operator to sign you in.",
        status: 403,
      });
    }

    const { data, error } = await parseBody(request, RegisterBody);
    if (error) return error;

    const problem = passwordProblem(data.password);
    if (problem) {
      return apiError({
        code: "WEAK_PASSWORD",
        message: problem,
        status: 422,
      });
    }

    const passwordHash = await hashPassword(data.password);

    let user;
    try {
      user = await prisma.user.create({
        data: {
          email: data.email,
          name: data.name && data.name.length > 0 ? data.name : null,
          passwordHash,
          automationSettings: { create: {} },
        },
      });
    } catch (cause) {
      // P2002 is the unique constraint on email. Answered as a plain conflict
      // rather than anything that reveals more about the existing account.
      if (
        cause instanceof Prisma.PrismaClientKnownRequestError &&
        cause.code === "P2002"
      ) {
        return apiError({
          code: "EMAIL_IN_USE",
          message: "An account already exists for that email address.",
          status: 409,
        });
      }
      throw cause;
    }

    const { token, expiresAt } = await createSession(user.id, {
      userAgent: request.headers.get("user-agent"),
      ipAddress:
        request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    });

    const response = ok(
      { user: { id: user.id, email: user.email, name: user.name } },
      201,
    );
    response.cookies.set(
      sessionCookie(token, expiresAt, new URL(request.url).protocol === "https:"),
    );
    return response;
  });
}
