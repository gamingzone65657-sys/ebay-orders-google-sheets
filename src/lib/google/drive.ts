/**
 * Spreadsheet discovery via the Drive API.
 *
 * Uses `drive.metadata.readonly`, which can read file names and ids but
 * cannot read file contents and cannot modify or delete anything.
 */

import type { GoogleConnection } from "@prisma/client";

import { GOOGLE_ENDPOINTS } from "./config";
import { googleRequest } from "./client";
import { GOOGLE_ERROR_CODES, GoogleApiError } from "./errors";

const SPREADSHEET_MIME = "application/vnd.google-apps.spreadsheet";

export interface DriveSpreadsheet {
  id: string;
  name: string;
  modifiedTime: string | null;
  ownerEmail: string | null;
  ownerName: string | null;
  webViewLink: string | null;
  shared: boolean;
}

interface RawDriveFile {
  id?: string;
  name?: string;
  modifiedTime?: string;
  webViewLink?: string;
  shared?: boolean;
  owners?: { emailAddress?: string; displayName?: string }[];
}

interface RawDriveList {
  files?: RawDriveFile[];
  nextPageToken?: string;
  incompleteSearch?: boolean;
}

/**
 * Escapes a value for Drive's query grammar, which uses single quotes and
 * backslash escapes. Without this, a spreadsheet name containing an
 * apostrophe would produce a malformed query.
 */
function escapeDriveQueryValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

export interface ListSpreadsheetsOptions {
  /** Substring match on the file name. */
  search?: string;
  pageSize?: number;
  pageToken?: string;
  signal?: AbortSignal;
}

export interface ListSpreadsheetsResult {
  spreadsheets: DriveSpreadsheet[];
  nextPageToken: string | null;
  /** Drive could not search every corpus (rare; shared-drive edge cases). */
  incompleteSearch: boolean;
}

export async function listSpreadsheets(
  connection: GoogleConnection,
  options: ListSpreadsheetsOptions = {},
): Promise<ListSpreadsheetsResult> {
  const clauses = [`mimeType='${SPREADSHEET_MIME}'`, "trashed=false"];
  const search = options.search?.trim();
  if (search) {
    clauses.push(`name contains '${escapeDriveQueryValue(search)}'`);
  }

  const response = await googleRequest<RawDriveList>(connection, {
    url: `${GOOGLE_ENDPOINTS.drive}/drive/v3/files`,
    label: "drive.files.list",
    query: {
      q: clauses.join(" and "),
      fields:
        "nextPageToken,incompleteSearch,files(id,name,modifiedTime,webViewLink,shared,owners(emailAddress,displayName))",
      orderBy: "modifiedByMeTime desc,modifiedTime desc",
      pageSize: Math.min(Math.max(options.pageSize ?? 100, 1), 200),
      pageToken: options.pageToken,
      // Include files on shared drives the user can see.
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      corpora: "allDrives",
      spaces: "drive",
    },
    signal: options.signal,
  });

  const files = Array.isArray(response.data?.files) ? response.data.files : [];

  return {
    spreadsheets: files
      .filter((file): file is RawDriveFile & { id: string } =>
        Boolean(file?.id),
      )
      .map((file) => ({
        id: file.id,
        name: file.name?.trim() || "(untitled spreadsheet)",
        modifiedTime: file.modifiedTime ?? null,
        ownerEmail: file.owners?.[0]?.emailAddress ?? null,
        ownerName: file.owners?.[0]?.displayName ?? null,
        webViewLink: file.webViewLink ?? null,
        shared: Boolean(file.shared),
      })),
    nextPageToken: response.data?.nextPageToken ?? null,
    incompleteSearch: Boolean(response.data?.incompleteSearch),
  };
}

/** Identity of the connected account, for the settings panel. */
export interface GoogleIdentity {
  sub: string | null;
  email: string | null;
  name: string | null;
  picture: string | null;
}

export async function fetchIdentity(
  connection: GoogleConnection,
): Promise<GoogleIdentity | null> {
  try {
    const response = await googleRequest<{
      sub?: string;
      email?: string;
      name?: string;
      picture?: string;
    }>(connection, {
      url: GOOGLE_ENDPOINTS.userinfo,
      label: "openid.userinfo",
    });
    const data = response.data ?? {};
    return {
      sub: data.sub ?? null,
      email: data.email ?? null,
      name: data.name ?? null,
      picture: data.picture ?? null,
    };
  } catch (error) {
    // Identity is cosmetic; never let it break a connection.
    if (error instanceof GoogleApiError) {
      console.warn(`[google] identity lookup unavailable (${error.code}).`);
      return null;
    }
    throw error;
  }
}

/** Cheapest authenticated call, used by "Test Google connection". */
export async function pingDrive(
  connection: GoogleConnection,
): Promise<{ user: string | null; storageQuotaKnown: boolean }> {
  const response = await googleRequest<{
    user?: { emailAddress?: string; displayName?: string };
    storageQuota?: unknown;
  }>(connection, {
    url: `${GOOGLE_ENDPOINTS.drive}/drive/v3/about`,
    label: "drive.about.get",
    query: { fields: "user(emailAddress,displayName),storageQuota(limit)" },
  });

  if (!response.data?.user) {
    throw new GoogleApiError(
      GOOGLE_ERROR_CODES.INVALID_RESPONSE,
      "Drive responded without a user object.",
    );
  }

  return {
    user:
      response.data.user.emailAddress ??
      response.data.user.displayName ??
      null,
    storageQuotaKnown: Boolean(response.data.storageQuota),
  };
}
