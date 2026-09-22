import { z } from "zod";

import { fail, handle, ok, parseBody } from "@/lib/api";
import { CONNECTION_STATUS } from "@/lib/constants";
import { tryDecryptSecret } from "@/lib/crypto";
import { prisma } from "@/lib/db";
import { getGoogleCredentials, isGoogleConfigured } from "@/lib/google/config";
import { revokeToken } from "@/lib/google/oauth";
import { getCurrentUser } from "@/lib/session";

const bodySchema = z.object({
  action: z.enum(["disconnect"]),
});

/**
 * Disconnecting.
 *
 * Connecting is a browser navigation to the OAuth start route, not a fetch —
 * the user has to land on the provider's consent page. Disconnecting is the
 * one connection action that stays server-side, so it is the only action this
 * route accepts.
 */
export async function POST(request: Request) {
  return handle(async () => {
    const { data, error } = await parseBody(request, bodySchema);
    if (error) return error;

    const user = await getCurrentUser();
    const existing = await prisma.googleConnection.findFirst({
      where: { userId: user.id, isActive: true },
    });

    void data;
    {
      if (!existing) return fail("No Google connection to disconnect.", 404);

      // Withdraw the grant at Google's end too, so the app disappears from
      // the user's account permissions rather than just being forgotten
      // locally. Best effort: local tokens are deleted either way.
      let revoked = false;
      const credentials = getGoogleCredentials();
      if (credentials) {
        const token =
          tryDecryptSecret(existing.refreshToken) ??
          tryDecryptSecret(existing.accessToken);
        if (token) revoked = await revokeToken(credentials, token);
      }

      await prisma.googleConnection.update({
        where: { id: existing.id },
        data: {
          status: CONNECTION_STATUS.DISCONNECTED,
          accessToken: null,
          refreshToken: null,
          tokenExpiresAt: null,
          tokenType: null,
          scopes: null,
          googleUserId: null,
          email: null,
          displayName: null,
          avatarUrl: null,
          connectedAt: null,
          lastRefreshedAt: null,
          rateLimitedUntil: null,
          lastError: null,
          lastErrorCode: null,
          lastErrorAt: null,
        },
      });

      return ok({
        status: CONNECTION_STATUS.DISCONNECTED,
        revokedAtGoogle: revoked,
        message: revoked
          ? "Google disconnected, stored tokens deleted, and access revoked at Google."
          : "Google disconnected and stored tokens deleted. Revoke at Google could not be confirmed — you can also remove access from your Google account permissions page.",
      });
    }

  });
}
