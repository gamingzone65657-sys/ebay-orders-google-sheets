# eBay Order → Google Sheets Automation Tool

| Phase | Status |
| --- | --- |
| 1 — foundation, database, auth-ready architecture, UI shell | done |
| 2 — eBay OAuth + live order retrieval | done |
| 3 — Google OAuth + spreadsheet/worksheet configuration | done |
| 4 — eBay → Google Sheets synchronization engine | done |
| 5 — filters, IF/THEN rules, expanded transformations | done |
| 6 — **reliable background synchronization** | done |
| 7 — sign-in | not started |

For a detailed record of what has been built, how it was verified, and what is
currently blocked, see **[PROGRESS.md](PROGRESS.md)**.

Orders are pulled from the **official eBay Sell Fulfillment API** over OAuth,
and the destination is chosen from the user's real Google Drive via the
**Google Sheets API**. Nothing is scraped, and the application never sees an
eBay or Google password.

**Sync Now** runs the full pipeline: fetch orders from eBay → retrieve line
items and shipments → normalize → apply the user's field mapping and
transformations → check for duplicates → insert or update rows in the chosen
worksheet → record the result.

---

## Quick start

```bash
npm install
npm run setup     # prisma generate + db push + seed demo workspace
npm run dev       # http://localhost:3000
```

Without eBay credentials the app still runs: a clearly-labelled demo
connection generates orders locally. To pull real orders, see
**Connecting a real eBay account** below.

`npm run setup` creates `prisma/dev.db` and seeds a demo workspace (48 orders,
8 sync runs, 10 field mappings).

To get back to a clean demo state, `npm run db:seed` is usually enough — it
deletes and recreates the demo workspace. `npm run db:reset` additionally
force-resets the schema, and Prisma will refuse to run it non-interactively.

| Script | Purpose |
| --- | --- |
| `npm run dev` | Development server |
| `npm run build` / `npm start` | Production build and serve |
| `npm run worker` | Background worker that runs scheduled syncs |
| `npm test` | Unit + integration tests (319 tests, no network needed) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run db:push` | Apply `schema.prisma` to the database |
| `npm run db:seed` | Seed the demo workspace |
| `npm run db:reset` | Force-reset the database and reseed |
| `npm run db:studio` | Prisma Studio |

## Stack

Next.js 15 (App Router) · React 19 · TypeScript · Tailwind CSS v4 · Prisma 6 ·
SQLite (dev) · Zod.

SQLite is a development choice only. Switching the `datasource` provider in
`prisma/schema.prisma` to `postgresql` requires no application code changes —
see *Portability* below.

---

## Routes

| Route | What it does |
| --- | --- |
| `/dashboard` | Connection, destination, schedule, and lifetime counters. Connect / Sync Now / Configure Mapping live here. |
| `/orders` | Imported orders, with search, SKU, status, marketplace, sync-state and date filters, plus pagination and the Import from eBay control. |
| `/orders/[id]` | One order: order info, buyer, payment, shipping, line items, tracking, and the raw eBay payload. Personal fields are masked until `?reveal=1`. |
| `/field-mapping` | Add, delete, enable, reorder, and transform column mappings, with a live preview. |
| `/google-sheet` | Connect Google, search and pick a spreadsheet, pick a worksheet, set the header row, see the sheet's real headers, run the three connection tests, and review the write plan. |
| `/filters` | Order/fulfillment/marketplace/SKU/date filters, and the IF/THEN rule builder. |
| `/automation` | Schedule, lookback window, status filter, retries, notifications. |
| `/sync-history` | Every run, filterable; `/sync-history/[id]` shows per-step logs. |
| `/settings` | Profile, eBay, Google, Sync, Automation, Security. |

API routes:

| Route | Purpose |
| --- | --- |
| `GET /api/auth/ebay/start` | Begins OAuth: issues the CSRF state cookie and redirects to eBay's consent page. |
| `GET /api/auth/ebay/callback` | Validates state, exchanges the code, encrypts and stores the tokens. |
| `POST /api/ebay/import` | Paginated order import. |
| `POST /api/ebay/test` | One cheap authenticated call to verify credentials, token and scopes. |
| `POST /api/connections/ebay` | `disconnect` (deletes tokens) or `connect-demo`. |
| `GET /api/auth/google/start` | Begins Google OAuth. |
| `GET /api/auth/google/callback` | Validates state, exchanges the code, verifies the granted scopes, stores encrypted tokens. |
| `GET /api/google/spreadsheets` | Lists (and searches) spreadsheets the account can see. |
| `GET /api/google/spreadsheets/[id]` | Worksheets of one spreadsheet, with ids and dimensions. Accepts an id or a URL. |
| `POST /api/google/test` | The three tests: `connection`, `spreadsheet`, `worksheet`. |
| `POST /api/connections/google` | `disconnect` (revokes at Google, then deletes tokens) or `connect-demo`. |
| `POST /api/sync/preview` | Dry run: what a sync would do. Writes nothing. |
| `POST /api/sync` | Starts a sync. Returns a job id immediately, or the full result with `wait: true`. |
| `GET /api/sync/jobs/[id]` | Live phase, progress and results for one run. |
| `PUT /api/filters` | Saves the order/fulfillment/marketplace/SKU/date filters. |
| `PUT /api/rules` | Replaces the IF/THEN rule set, validated server-side. |
| `POST /api/jobs/tick` | Runs one worker tick. For an external cron; requires `CRON_SECRET`. |
| `POST\|PATCH /api/sheet-config` · `PUT\|POST /api/mappings` · `PUT /api/automation` · `PUT /api/settings` · `POST /api/saved-configurations` · `POST\|DELETE /api/saved-configurations/[id]` | Configuration routes. |

---

## Connecting a real eBay account

1. At [developer.ebay.com](https://developer.ebay.com), open **Application
   Keys** and copy the **App ID** and **Cert ID** for the keyset you want
   (Sandbox or Production).
2. On the same keyset choose **User Tokens → Get a Token from eBay via Your
   Application**. Create an **RuName** and set its *auth accepted URL* to
   `http://localhost:3000/api/auth/ebay/callback` (your real https origin in
   production).
3. Fill in `.env`:

   ```ini
   EBAY_ENVIRONMENT="SANDBOX"      # or PRODUCTION — must match the keyset
   EBAY_CLIENT_ID="<App ID>"
   EBAY_CLIENT_SECRET="<Cert ID>"
   EBAY_RU_NAME="<RuName, not a URL>"
   AUTH_SECRET="<32+ random characters>"   # encrypts the stored tokens
   ```

4. Restart, open **Settings → eBay**, and press **Connect eBay**. You sign in
   on eBay's own page; this app never receives your password.
5. Open **Orders** and press **Import from eBay**.

> `EBAY_RU_NAME` is an RuName, not a URL — eBay's authorization-code flow puts
> the RuName in the `redirect_uri` parameter and resolves the real callback URL
> from it. Using a URL here produces an `invalid_request` from eBay.

**Scopes requested:** `api_scope`, `sell.fulfillment.readonly` (read-only — the
app cannot modify your orders), and `commerce.identity.readonly` so the account
panel can show your eBay username. If your keyset does not have the identity
scope, eBay rejects the whole consent request; set
`EBAY_REQUEST_IDENTITY_SCOPE=false` and the app falls back to showing the
seller id.

---

## Connecting a real Google account

1. In the [Google Cloud console](https://console.cloud.google.com), pick or
   create a project.
2. **APIs & Services → Library** — enable both **Google Sheets API** and
   **Google Drive API**.
3. **APIs & Services → OAuth consent screen** — configure it. While the app is
   in *Testing*, add your own Google account under **Test users**, or consent
   will be refused.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**,
   type **Web application**. Under *Authorized redirect URIs* add exactly:

   ```
   http://localhost:3000/api/auth/google/callback
   ```

5. Put the client id and secret in `.env`:

   ```ini
   GOOGLE_CLIENT_ID="…apps.googleusercontent.com"
   GOOGLE_CLIENT_SECRET="…"
   ```

6. Restart, open **Google Sheet**, and press **Connect Google**.

> Unlike eBay's RuName, this **is** a literal URL and must match character for
> character, including the scheme and port — otherwise Google returns
> `redirect_uri_mismatch`. The exact expected value is shown on the page when
> credentials are missing, so it can be copied rather than typed.

**Scopes requested:**

| Scope | Why |
| --- | --- |
| `openid`, `email`, `profile` | Show which account is connected. |
| `drive.metadata.readonly` | List spreadsheet names and ids. Cannot read file contents, and cannot modify or delete anything. |
| `spreadsheets` | Read the header row now; write order rows in Phase 4. |

The write scope is requested up front so consent happens once rather than
again next phase — but **nothing in this phase writes**. Set
`GOOGLE_REQUEST_WRITE_SCOPE=false` to request `spreadsheets.readonly` instead;
everything here works either way.

Google lets a user untick individual permissions on the consent screen, so the
callback verifies what was actually granted and refuses to save a connection
that cannot list files or read values, rather than failing confusingly later.

---

## Data model

```
User ─┬─ Session                       (auth-ready; no login screen yet)
      ├─ UserPreference                (key/value settings)
      ├─ EbayConnection ───── EbayApiCall      (one row per outbound request)
      ├─ GoogleConnection ── GoogleApiCall     (same, for Google)
      │        │
      ├─ GoogleSheetConfig ┴─┬─ SheetColumn    (detected headers, as data)
      │                      └─ FieldMapping   (column ⇄ field, as strings)
      ├─ SavedConfiguration ── FieldMapping    (named reusable mapping sets)
      ├─ ImportedOrder ──┬─ OrderLineItem
      │                  ├─ OrderFulfillment   (shipments / tracking)
      │                  └─ SyncLog
      ├─ SyncJob ──────────── SyncLog
      └─ AutomationSetting
```

Full annotated schema: [`prisma/schema.prisma`](prisma/schema.prisma).

### The two rules this schema is built around

**1. No eBay field is ever a database column.**
`FieldMapping.sourceField` stores a dot-path string such as
`order.buyer.username` or `lineItem.sku`. At sync time
[`getByPath`](src/lib/json.ts) resolves that path against the order payload.
The list of selectable fields lives in
[`src/lib/ebay-fields.ts`](src/lib/ebay-fields.ts) — a presentation catalogue
that nothing in the database or sync engine reads from. Replacing it with a
list built from a live API response adds fields with **no migration** and
without breaking mappings a user already saved.

**2. No Google Sheet column is ever a database column.**
Detected headers are rows in `SheetColumn`; mapping targets are free-form
strings in `FieldMapping.targetColumn`. Renaming a header only requires a
re-detect.

`ImportedOrder.rawPayloadJson` keeps the verbatim eBay payload, so a mapping
added next month can be re-applied to orders already imported.

Transformations are the same story: a mapping stores a registry id plus a JSON
argument bag, and [`src/lib/transformations.ts`](src/lib/transformations.ts)
holds the implementations. Adding one there makes it immediately selectable in
the UI and usable by the sync engine.

### Portability

SQLite supports neither `enum` nor `Json` through Prisma, so:

- enum-ish columns are `String`, with the unions in
  [`src/lib/constants.ts`](src/lib/constants.ts);
- JSON blobs are `String` columns suffixed `...Json`, read and written only
  through [`src/lib/json.ts`](src/lib/json.ts).

Both map straight onto Postgres native types later, and every call site already
goes through one helper.

---

## Authentication-ready architecture

There is no login screen in Phase 1. The schema already carries `User`,
`User.passwordHash`, and `Session` (with hashed tokens and expiry), and **every
page and API route** resolves its data through one function:

```ts
// src/lib/session.ts
const user = await getCurrentUser();
```

`getCurrentUser()` reads the `ebs_session` cookie, looks up a live `Session`,
and — while `ALLOW_ANONYMOUS_FALLBACK` is `true` — falls back to the workspace
owner. Phase 2 adds the sign-in routes that issue a `Session` row and flips
that flag to `false`. No page, query, or route handler changes.

> Because of that fallback, this build should not be exposed publicly as-is.

---

## The eBay integration

All eBay traffic is server-side. The browser talks only to this app's own API
routes; it never receives a token, a client secret, or an eBay URL to call.

```
src/lib/ebay/
  config.ts          credentials, endpoints, scopes (throws if imported client-side)
  oauth.ts           authorization URL, code exchange, refresh
  oauth-state.ts     CSRF state cookie contract, shared by both routes
  tokens.ts          expiry checks, refresh, token health for the UI
  client.ts          the only outbound path: auth, pacing, retries, logging
  rate-limit.ts      per-connection pacing, 429 cooldown, backoff
  orders.ts          paginated getOrders + shipping fulfillments
  normalize.ts       eBay payload -> internal model (defensive)
  identity.ts        seller username lookup (optional scope)
  import-orders.ts   the pipeline: fetch -> normalize -> upsert -> job + logs
  errors.ts          error categories and the messages sellers see
```

**Token handling.** Access and refresh tokens are AES-256-GCM encrypted with a
key derived from `AUTH_SECRET` before they touch the database
([`src/lib/crypto.ts`](src/lib/crypto.ts)). Every request goes through
`getValidAccessToken`, which refreshes anything within two minutes of expiry
and collapses concurrent refreshes into a single call. When eBay rejects the
refresh token the connection flips to `EXPIRED` and the UI asks the seller to
reconnect. Disconnecting deletes the stored tokens outright.

**Pagination.** `getOrders` caps out at 200 orders per call, so
[`fetchOrders`](src/lib/ebay/orders.ts) walks offsets until eBay runs out,
deduplicating ids that repeat across pages if the data shifts mid-walk. Guards
(`maxPages`, `maxOrders`) stop a runaway loop, and when one trips the run is
reported as **truncated** rather than quietly returning a partial set.

**Rate limits.** Requests for one connection are serialised with a minimum gap
between them; a 429 starts a cooldown that makes later calls fail fast instead
of piling on, persisted to `rateLimitedUntil` so the UI can explain the wait.
Retries use exponential backoff with jitter and honour `Retry-After`. Shipment
lookups cost one call per shipped order, so they run under a per-run budget
(`EBAY_FULFILLMENT_CALL_BUDGET`) and defer the remainder to the next run.

**Normalization.** [`normalize.ts`](src/lib/ebay/normalize.ts) assumes nothing:
every field is read through a helper that tolerates null, the wrong type, and
unparseable values. A malformed order degrades to a partial record instead of
failing the import; an order with no id is counted as unusable rather than
guessed at. The Fulfillment API has no single "order status" field, so the one
the UI filters on is *derived* from cancellation, payment and fulfillment
state, with all three kept verbatim alongside it.

**Errors.** Every failure becomes an `EbayApiError` with a category —
`NOT_CONFIGURED`, `NOT_CONNECTED`, `OAUTH_FAILED`, `AUTH_EXPIRED`,
`PERMISSION_DENIED`, `RATE_LIMITED`, `SERVER_ERROR`, `BAD_REQUEST`,
`INVALID_RESPONSE`, `NETWORK_ERROR` — each mapped to an actionable message.
A blocked import is a recorded `FAILED` job with logs, not an HTTP error.

**Privacy.** Buyer name, email, phone, street address, postcode and tracking
numbers are masked on the orders table and the order detail page, including
inside the raw-payload panel. `?reveal=1` shows the real values.

---

## The Google integration

Same shape as the eBay layer, deliberately: one config module, one client that
everything goes through, one token manager, categorised errors.

```
src/lib/google/
  config.ts          credentials, endpoints, scopes (throws if imported client-side)
  oauth.ts           authorization URL, code exchange, refresh, revoke
  oauth-state.ts     CSRF state cookie contract, shared by both routes
  tokens.ts          expiry checks, refresh, token health for the UI
  client.ts          the only outbound path: auth, pacing, retries, logging
  drive.ts           spreadsheet discovery + identity
  sheets.ts          worksheet metadata + header-row reads (read-only by construction)
  errors.ts          error categories and the messages users see
src/lib/http/
  rate-limit.ts      shared limiter; eBay and Google namespace their own keys
src/lib/sheets/
  write-plan.ts      which columns would be written, and which never will be
```

**Read-only, by construction.** `sheets.ts` contains no call to
`values.update`, `values.append`, `values.clear` or `batchUpdate`. The Phase 4
writer will live in its own module, so "can this code modify my spreadsheet?"
is answerable by reading the imports. Metadata reads deliberately omit
`includeGridData`, so no cell values are transferred when listing worksheets.

**The write plan.** [`write-plan.ts`](src/lib/sheets/write-plan.ts) turns the
detected headers plus the saved mappings into an explicit statement of intent,
rendered at the bottom of the Google Sheet page:

- every mapped column resolved to a real column letter,
- every existing column that is **not** mapped, listed as untouched,
- mapped targets that do not exist yet, flagged as "would create",
- duplicates, blanks and an excessive number of new columns as *blockers*.

It refuses to call a configuration safe if two mappings target the same column
or if more than five columns would need creating. Phase 4's writer must check
`safe` and write only to the listed letters.

**Error categories.** Google overloads HTTP 403 across quota exhaustion,
missing scopes and plain permission failures, so
[`classifyGoogleError`](src/lib/google/errors.ts) reads the `reason` field
before the status code. That is what makes a quota 403 retryable while a
permission 403 fails immediately with "this account cannot open that file".

**Disconnect actually disconnects.** It calls Google's revoke endpoint before
deleting the local tokens, so the app disappears from the account's third-party
permissions rather than merely being forgotten here.

---

## The sync engine

```
src/lib/sync/
  sheet-sync.ts      planSync() + runSheetSync() — the pipeline
  build-row.ts       expand an order into rows, resolve each cell
  demo-import.ts     the no-credentials fallback
src/lib/google/
  sheets-write.ts    the only module that can modify a spreadsheet
```

`planSync()` and `runSheetSync()` share one planning pass, so **the preview a
user confirms is computed by exactly the code that then performs the write**.
A separate "estimate" implementation would be free to disagree with reality.

### Duplicate protection

The key column is the identity of a row. Before writing anything, the engine
**reads that column out of the live sheet** and reconciles it against the
planned rows. Reading the sheet rather than trusting `SheetRowLink` is what
makes the guard correct when the local database is fresh, when the sheet was
edited by hand, or when rows were moved.

- **ORDER mode** — the key is the eBay order id.
- **LINE_ITEM mode** — the key must be unique per line item. The engine
  verifies this from the *actual planned values* and refuses the run if any
  key repeats, rather than silently collapsing items onto one row. Map the key
  column to **Row Key (unique)** (`computed.rowKey`, which emits
  `orderId::lineItemId`) or to the line item id.

An order that already has a row is updated in place. The classic case works:
an order syncs with no tracking, eBay later supplies one, and the next run
updates that same row instead of appending a second.

Rows whose values are unchanged since the last write are skipped using a
stored hash, so a repeat sync costs no API calls.

### Sync modes and ranges

| Mode | Behaviour |
| --- | --- |
| Append | Only add rows for orders not in the sheet. Existing rows untouched. |
| Update | Only refresh existing rows. New orders are skipped. |
| Append + update | Both. The default. |

Ranges: last 24 hours, 7 / 30 / 90 days, a custom range, or **since last
successful sync** (the default). The "since last" cursor overlaps the previous
cutoff by an hour, because an order modified moments before it could have been
written before eBay finished updating it. With no previous run it falls back
to 30 days.

### Write safety

Three independent guarantees, in order:

1. [`write-plan.ts`](src/lib/sheets/write-plan.ts) resolves every mapped
   column to a letter and refuses to report `safe` on duplicates, a missing
   key column, or more than five columns needing creation.
2. `planSync()` refuses to write at all while any blocker stands.
3. [`sheets-write.ts`](src/lib/google/sheets-write.ts) writes **by explicit
   A1 range, built only from contiguous runs of mapped columns**. Mapped
   columns A, B, D, E produce two ranges (`A:B`, `D:E`) — never `A:E` — so the
   unmapped column C cannot be blanked. There is no `values.clear`, no delete
   and no row-level write anywhere in the codebase.

Appending grows the grid with `appendDimension` when needed; that is the only
structural change the app can make, and it only ever adds empty rows.

### Failure isolation

Writes go out in batches of 50. A failed batch marks only its own rows failed,
records them against their orders, and the loop continues. The run stops early
only for a failure that would certainly affect every remaining batch (expired
auth, missing scope, deleted sheet). An order with no stored payload is
recorded and skipped rather than aborting the run.

### Progress

`POST /api/sync` returns a job id immediately and runs detached, updating
`SyncJob.phase` as it goes; the UI polls `/api/sync/jobs/[id]` and shows
*Fetching orders… → Processing… → Writing to Google Sheets… → Completed* with
a row counter. Results are reported as **found / inserted / updated / skipped
/ failed**.

> Running detached is fine for one long-lived Node process. A multi-instance
> deployment should move this onto a job queue — the `SyncJob` row is already
> the unit of work that would be enqueued.

---

## Filters and rules

Everything here is configured from `/filters` and stored as data. Adding a
SKU, a marketplace or a rule never requires a code change.

### Filters

Applied before rows are built, so they narrow what the database returns
rather than what gets discarded afterwards.

| Filter | Options |
| --- | --- |
| Order status | Paid · Awaiting payment · Shipped · Completed · Cancelled |
| Fulfillment | Unfulfilled · Partially fulfilled · Fulfilled |
| Marketplace | Any eBay marketplace seen in your orders |
| SKU | All · Include selected · Exclude selected · contains · starts with · ends with |
| Date | Optional hard bounds that narrow the range chosen at sync time |

Two decisions worth knowing:

- **Selecting nothing means "all".** There is no "All" token to store, so an
  empty selection is unambiguous rather than a special case.
- **Order-status options overlap deliberately.** eBay reports payment,
  fulfillment and cancellation independently, so an order can legitimately be
  both Paid and Shipped. Selections are OR-ed.

SKU filtering is applied where it makes sense for the row mode: in
one-row-per-order mode an order survives if *any* item matches, so a
multi-item order is never partly lost; in one-row-per-line-item mode each row
is filtered on its own SKU. SKUs are read from the stored eBay payload — the
same source the mapper reads — so the filter can never disagree with what
gets written.

### Rules

```
IF  SKU contains "ABC"        THEN import only matching rows
IF  marketplace is EBAY_GB    THEN use saved configuration "UK export"
IF  tracking is empty         THEN set "Status" to "Awaiting dispatch"
```

A rule is a flat list of conditions combined with **all** or **any**, plus one
of four actions: skip the row, import only matching rows (a whitelist), set a
column to a value, or build the row with a different saved mapping set.
No nesting, no expression language.

Rules run in order, and the resolution is explicit:

1. A matching **skip** wins immediately — never undone by a later rule.
2. If any **import only** rule exists, a row must match at least one.
3. **Set a column** overrides accumulate; the later rule wins on a clash.
4. The last matching **use a saved configuration** decides the mapping set.

A rule with no conditions is treated as *never matches*, so a half-finished
rule is inert rather than destructive. Each rule records how many rows it
matched on the last run, so a rule that silently does nothing is visible.

### Transformations

Grouped in the mapping editor:

| Group | Transformations |
| --- | --- |
| Basic | None · Default if empty |
| Text | Trim · UPPERCASE · lowercase · Title Case · Add prefix · Add suffix · Prefix and suffix · Clean up text · Find and replace · Truncate |
| Numbers & dates | Format date · Format number · Round number · Format currency |
| Logic | Conditional value · Yes / No |
| Combine | Combine fields · Join list |

**Combine fields** needs more than the one mapped value, so transformations
receive an optional context whose `resolve` reads any dot-path from the
current row. That is injected by the caller, which keeps
[`transformations.ts`](src/lib/transformations.ts) independent of the sync
engine. **Format currency** uses the same hook to fall back to the order's own
currency when no code is given — the right default on a multi-marketplace
account.

### Multi-item handling

| Field | Produces |
| --- | --- |
| `computed.skuList` / `titleList` / `quantityList` | Pre-joined strings |
| `computed.skus` / `titles` / `quantities` | Raw arrays, for **Join list** (separator, de-duplicate, cap with "+N more") |
| `computed.itemSummary` | `2 × TSH-BLK-L — Cotton Tee; 1 × MUG-CER-01 — Coffee Mug` |
| `computed.rowKey` | `orderId::lineItemId` — the unique key for line-item mode |

---

## Background synchronization

Scheduled syncs run through a database-backed job queue. There are two ways
to drive it, and they are safe to run at the same time:

```bash
npm run worker          # a long-running process, polls every 30s
```
```bash
# or point a cron at the endpoint (serverless-friendly)
curl -X POST -H "Authorization: Bearer $CRON_SECRET" \
  https://your-host/api/jobs/tick
```

Both call the same `tick()`. **Sync Now works with neither running** — a
manual sync executes inline in the web request, which is the whole point of
the button.

### One tick

1. Reclaim jobs abandoned by a crashed worker.
2. Enqueue any schedule that has come due.
3. Claim and run queued jobs.

The run itself is `runSheetSync` — the same function a manual sync calls, so
scheduled and manual behaviour cannot drift apart: authenticate with eBay →
retrieve new/updated orders → apply filters → apply mapping → update the
sheet → record results → advance the cursor.

### How concurrency is made safe

Claiming is a **conditional update**: `updateMany` with the expected status
in the `where` clause affects exactly one row or none, and the database picks
the winner. No broker, no lock table for the job itself.

That alone is not enough to guarantee *one sync per workspace*, because two
requests can each create their own job row and each win its own
compare-and-swap. So there is a `SyncLock` row keyed by user id: `create`
succeeds for exactly one caller. The mutex is taken **before** the job is
claimed, which removes the ambiguity entirely — deciding a winner afterwards
by comparing timestamps does not work, since a caller whose rival has not yet
committed sees no rival at all.

Crash recovery falls out of the same design: a running job writes a
heartbeat, and both the job and the mutex are reclaimed once it goes stale.
A killed worker cannot wedge a workspace.

### Incremental by default

Scheduled runs always use **since last successful sync**. The cursor
(`lastSyncedThrough`) and `lastSuccessAt` advance **only on a successful
run** — a failure can never look like a success, and can never silently skip
a window of orders. The window overlaps the previous cutoff by an hour,
because an order modified moments before it could have been written before
eBay finished updating it.

### Failure handling

| Category | Behaviour |
| --- | --- |
| Rate limited, 5xx, network, lost worker | Retried with exponential backoff, capped at an hour |
| Expired auth, missing scope, deleted sheet, configuration blocker | Failed immediately — a retry cannot fix it, and would burn quota |
| Unexpected exception | Retried once per attempt budget |

Retries cannot duplicate rows: the engine re-reads the sheet's key column on
every attempt, so a retried write updates the row it already created.

After `MAX_CONSECUTIVE_FAILURES` (5) the schedule is **paused** with a stated
reason rather than retrying forever. Saving the automation form clears it.

`npx tsx scripts/verify-worker.ts` makes a schedule due, runs one tick, and
prints exactly what happened to it — useful for confirming the loop end to
end against your real configuration.

---

## What is real vs. generated

Everything generated is labelled in the UI: demo connections show **Demo
mode**, generated orders carry a **Demo** badge and are stored with
`source: "DEMO"`, and demo runs are flagged on the job.

| Area | Behaviour |
| --- | --- |
| eBay connection | **Real OAuth** against eBay. A `DEMO` placeholder connection remains available for running the app without credentials. |
| eBay orders | **Real**, from `GET /sell/fulfillment/v1/order`, fully paginated. |
| Tracking | **Real**, from `GET /sell/fulfillment/v1/order/{id}/shipping_fulfillment`. |
| Seller username | **Real**, from `GET /commerce/identity/v1/user/` when the scope is granted. |
| Google connection | **Real OAuth**, with refresh and revoke-on-disconnect. A `DEMO` placeholder remains for running without credentials. |
| Spreadsheet list | **Real**, from `GET /drive/v3/files` filtered to spreadsheets. |
| Worksheets + dimensions | **Real**, from `GET /v4/spreadsheets/{id}` metadata. |
| Header row | **Real**, from `GET /v4/spreadsheets/{id}/values/{range}`. |
| Sheets writing | **Real**, via `values:batchUpdate` on explicitly mapped ranges. |
| Automation | **Real** — a durable queue with locking, crash recovery and retry. Needs `npm run worker` or a cron on `/api/jobs/tick`. |
| Notifications | Stored, not delivered. |

When either connection is in `DEMO` mode the corresponding fixtures are used
instead, and every surface says so.

---

## Testing

```bash
npm test     # 319 tests, ~50s, no network access required
```

| File | Covers |
| --- | --- |
| `tests/normalize.test.ts` | Safe readers, status derivation, a complete payload, a near-empty one, a deliberately malformed one, and the eBay filter grammar. |
| `tests/security.test.ts` | Token encryption round-trip, tamper detection, key rotation, constant-time state comparison, and every masking rule. |
| `tests/rate-limit.test.ts` | Backoff growth and clamping, `Retry-After`, cooldown scoping and expiry, request pacing, HTTP→category classification. |
| `tests/ebay-integration.test.ts` | The real eBay client, token manager, pagination walker and import pipeline against an isolated SQLite database with the HTTP transport stubbed. |
| `tests/google-units.test.ts` | Spreadsheet id/URL parsing, A1 quoting and escaping, Google's overloaded 403s, and every write-plan rule. |
| `tests/google-integration.test.ts` | The real Google client, token manager, Drive listing and Sheets reads, likewise against an isolated database with the transport stubbed. |
| `tests/sync-units.test.ts` | A1 range construction (including the gap-splitting that protects unmapped columns), order→row expansion, and every date range. |
| `tests/sync-integration.test.ts` | The whole engine against an in-memory fake spreadsheet: inserts, updates, duplicate protection, all three sync modes, line-item mode, safety refusals, batch-failure isolation, filters, rules, and preview accuracy. |
| `tests/filters-rules.test.ts` | Every filter mode and rule operator, rule precedence, validation, and each new transformation. |
| `tests/schedule.test.ts` | Interval clamping, timezone-aware quiet hours (including windows that wrap midnight), next-run computation, backoff, and retry classification. |
| `tests/worker-integration.test.ts` | The queue against a real database: dedupe races, exclusive claiming, the workspace mutex, stale-lock takeover, crash recovery, retry scheduling, and due-schedule enqueuing. |

Each integration file uses its own database file, because `node --test` runs
test files in parallel processes.

The integration tests inject a fake transport
([`setEbayTransport`](src/lib/ebay/client.ts)) rather than mocking the modules
under test, so everything below the network boundary is production code. They
cover: bearer + marketplace headers, retry on 429/5xx/network, no retry on
401/403, non-JSON success bodies, the cooldown short-circuit, refresh on
expiry, `invalid_grant` marking the connection expired, concurrent refresh
collapsing, a 450-order three-page walk, cross-page duplicates, page and order
guards, a full import with tracking, re-import updating rather than
duplicating, and every blocked-import path.

Two real bugs were found and fixed by these tests: the marketplace header was
not defaulted from the connection, and the retry limit was read at module load
so it could not be configured.

---

## Where later phases plug in

| Phase | Change |
| --- | --- |
| 7 — Auth | Add sign-in routes issuing `Session` rows; set `ALLOW_ANONYMOUS_FALLBACK = false`. |
| 7 — Notifications | `notifyOnError` / `notifyOnSuccess` are stored but nothing is delivered. The hook is `runClaimedJob`'s success/failure branches. |
| Scaling | The queue is correct for several workers against one database. Moving to Postgres would let `claimNextJob` use `SELECT … FOR UPDATE SKIP LOCKED` instead of the candidate-then-CAS loop. |

---

## Project layout

```
prisma/
  schema.prisma          annotated data model
  seed.ts                demo workspace
src/
  app/
    (app)/               sidebar-shell pages + error boundary
    api/                 route handlers
  components/
    layout/              AppShell, sidebar nav, page header
    ui/                  Button + primitives (Card, Badge, Field, Notice…)
    dashboard/ orders/ mapping/ sheet/ automation/ settings/
  lib/
    db.ts                Prisma client singleton
    session.ts           getCurrentUser() — the single auth seam
    crypto.ts            AES-256-GCM token encryption
    mask.ts              buyer PII masking
    constants.ts         enum replacements
    json.ts              JSON-column + dot-path helpers
    ebay-fields.ts       source field catalogue (swappable)
    transformations.ts   transformation registry
    mapping-suggest.ts   auto-map heuristics
    queries.ts           page-level reads
    ebay/                the eBay integration (see above)
    google/              the Google integration (see above)
    http/                rate-limit.ts, shared by both providers
    sheets/              write-plan.ts — the safety guarantee
    mock/                Drive fixture + demo order generator
    sync/                build-row.ts, run-sync.ts, demo-import.ts
tests/
  fixtures/              realistic eBay payloads, incl. sparse + malformed
  helpers/test-db.ts     isolated SQLite database for integration tests
```
