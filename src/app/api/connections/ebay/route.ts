import { z } from "zod";

import { fail, handle, ok, parseBody } from "@/lib/api";
import { CONNECTION_STATUS } from "@/lib/constants";
import { prisma } from "@/lib/db";
import { isEbayConfigured } from "@/lib/ebay/config";
import { getCurrentUser } from "@/lib/session";

const bodySchema = z.object({
  action: z.enum(["disconnect"]),
  environment: z.enum(["SANDBOX", "PRODUCTION"]).optional(),
  marketplaceId: z.string().min(1).max(32).optional(),
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
    const existing = await prisma.ebayConnection.findFirst({
      where: { userId: user.id, isActive: true },
    });

    void data;
    {
      if (!existing) return fail("No eBay connection to disconnect.", 404);

      await prisma.ebayConnection.update({
        where: { id: existing.id },
        data: {
          status: CONNECTION_STATUS.DISCONNECTED,
          // Tokens are destroyed here rather than merely flagged inactive.
          accessToken: null,
          refreshToken: null,
          tokenExpiresAt: null,
          refreshExpiresAt: null,
          tokenType: null,
          scopes: null,
          ebayUserId: null,
          ebayUsername: null,
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
        message:
          "eBay disconnected and stored tokens deleted. Previously imported orders were kept.",
      });
    }

  });
}
