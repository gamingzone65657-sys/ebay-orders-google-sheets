import { handle, ok } from "@/lib/api";
import { CONNECTION_STATUS } from "@/lib/constants";
import { prisma } from "@/lib/db";
import { describeEbayError } from "@/lib/ebay/errors";
import { fetchIdentity } from "@/lib/ebay/identity";
import { pingOrdersApi } from "@/lib/ebay/orders";
import { getActiveEbayConnection } from "@/lib/ebay/tokens";
import { getCurrentUser } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * Verifies credentials, token, and scopes in one cheap round trip
 * (getOrders with limit=1). Refreshes the access token as a side effect if
 * it had expired, which is exactly what we want to confirm works.
 */
export async function POST() {
  return handle(async () => {
    const user = await getCurrentUser();
    const connection = await getActiveEbayConnection(user.id);

    if (!connection || connection.status === CONNECTION_STATUS.DISCONNECTED) {
      return ok({
        reachable: false,
        code: "NOT_CONNECTED",
        message: "No eBay account is connected.",
      });
    }


    try {
      const ping = await pingOrdersApi(connection);

      // Opportunistically refresh the account panel while we are here.
      const identity = await fetchIdentity(connection).catch(() => null);
      if (identity?.username || identity?.userId) {
        await prisma.ebayConnection.update({
          where: { id: connection.id },
          data: {
            ebayUsername: identity.username ?? connection.ebayUsername,
            ebayUserId: identity.userId ?? connection.ebayUserId,
          },
        });
      }

      return ok({
        reachable: true,
        environment: connection.environment,
        marketplaceId: connection.marketplaceId,
        ordersVisible: ping.reportedTotal,
        username: identity?.username ?? connection.ebayUsername ?? null,
        message:
          ping.reportedTotal === null
            ? "eBay responded successfully."
            : `eBay responded successfully. ${ping.reportedTotal} order(s) visible to this account.`,
      });
    } catch (error) {
      const described = describeEbayError(error);
      return ok({
        reachable: false,
        code: described.code,
        message: described.message,
        detail: described.detail,
        retryAfterSeconds: described.retryAfterSeconds,
      });
    }
  });
}
