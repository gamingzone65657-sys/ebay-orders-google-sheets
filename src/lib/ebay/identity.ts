/**
 * Seller identity lookup (Commerce Identity API).
 *
 * This is the only way to learn the connected seller's eBay username — the
 * Fulfillment API reports an opaque `sellerId` and the buyer's username, not
 * the seller's.
 *
 * It needs the `commerce.identity.readonly` scope. That scope is requested at
 * consent time only when EBAY_REQUEST_IDENTITY_SCOPE is not "false", and every
 * failure here is non-fatal: the connection still works, the account panel
 * just shows the seller id instead of a username.
 */

import type { EbayConnection } from "@prisma/client";

import { ebayRequest } from "./client";
import { EbayApiError } from "./errors";
import { safeString } from "./normalize";

export interface EbayIdentity {
  userId: string | null;
  username: string | null;
  accountType: string | null;
  registrationMarketplaceId: string | null;
  email: string | null;
}

interface RawIdentity {
  userId?: string;
  username?: string;
  accountType?: string;
  registrationMarketplaceId?: string;
  email?: string;
  individualAccount?: { firstName?: string; lastName?: string };
  businessAccount?: { name?: string; email?: string };
}

export async function fetchIdentity(
  connection: EbayConnection,
): Promise<EbayIdentity | null> {
  try {
    const response = await ebayRequest<RawIdentity>(connection, {
      // getUser is served from apiz.ebay.com. api.ebay.com answers this exact
      // path with a 404 — see EbayEndpoints.apiz.
      host: "apiz",
      path: "/commerce/identity/v1/user/",
      marketplaceId: connection.marketplaceId,
      // A username is decoration. Its failure must not make a connection that
      // is importing orders look broken.
      optional: true,
    });

    const data = response.data ?? {};
    return {
      userId: safeString(data.userId),
      username: safeString(data.username),
      accountType: safeString(data.accountType),
      registrationMarketplaceId: safeString(data.registrationMarketplaceId),
      email: safeString(data.email) ?? safeString(data.businessAccount?.email),
    };
  } catch (error) {
    // A missing scope is the expected failure here, not an exceptional one.
    if (error instanceof EbayApiError) {
      console.warn(
        `[ebay] identity lookup unavailable (${error.code}). ` +
          "The connection is still usable; the account panel will show the seller id.",
      );
      return null;
    }
    throw error;
  }
}
