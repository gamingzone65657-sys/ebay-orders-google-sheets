# Project status

**eBay Order → Google Sheets Automation Tool**
Last updated: 2026-09-22 (Phase 6)

Setup instructions and architecture notes live in [README.md](README.md). This
file records what has actually been built, what has been verified and how, and
what is currently blocking progress.

---

## At a glance

| Phase | Scope | Status |
| --- | --- | --- |
| 1 | Foundation, database, auth-ready architecture, full UI | **Complete** |
| 2 | eBay OAuth + live order retrieval | **Code complete** — blocked on eBay production credentials |
| 3 | Google OAuth + spreadsheet/worksheet configuration | **Code complete** — needs Google Cloud credentials to exercise live |
| 4 | eBay → Google Sheets synchronization engine | **Code complete** — verified against a fake sheet, not yet against live Google |
| 5 | Filters, IF/THEN rules, expanded transformations | **Complete** |
| 6 | Reliable background synchronization | **Complete** |
| 7 | Sign-in + notification delivery | Not started |

**Current blocker:** the production eBay keyset returns `invalid_client` and
no eBay RuName exists yet. Google Cloud credentials **have now been supplied**,
so the Google half can be connected and exercised for real. Detail in
[Open items](#open-items).

---

## Phase 1 — foundation (complete)

### Application
- Next.js 15 (App Router) · React 19 · TypeScript · Tailwind v4 · Prisma 6 ·
  SQLite · Zod.
- 7 sidebar pages, all implemented and reachable: Dashboard, Orders, Field
  Mapping, Google Sheet, Automation, Sync History, Settings — plus two detail
  routes (`/orders/[id]`, `/sync-history/[id]`).
- Responsive desktop-first shell, an error boundary on the app segment, and a
  404 page. No route or button errors.

### Database — 16 models
`User`, `Session`, `UserPreference`, `EbayConnection`, `EbayApiCall`,
`GoogleConnection`, `GoogleSheetConfig`, `SheetColumn`, `FieldMapping`,
`SavedConfiguration`, `ImportedOrder`, `OrderLineItem`, `OrderFulfillment`,
`SyncJob`, `SyncLog`, `AutomationSetting`.

Two constraints from the brief were treated as load-bearing and shaped the
schema:

- **No eBay field is a database column.** `FieldMapping.sourceField` holds a
  dot-path string (`order.buyer.username`), resolved at runtime. The field
  catalogue lives in code, not the database, so new eBay fields need no
  migration and never break saved mappings.
- **No Google Sheet column is a database column.** Detected headers are
  `SheetColumn` rows; mapping targets are free-form strings.

`ImportedOrder.rawPayloadJson` keeps the verbatim eBay payload, so a mapping
added later can be re-applied to orders already imported.

### Auth-ready architecture
`User`, `User.passwordHash` and `Session` (hashed tokens, expiry) all exist.
Every page and API route resolves data through a single `getCurrentUser()` in
[`src/lib/session.ts`](src/lib/session.ts). Phase 2's remaining work is to add
sign-in routes and flip `ALLOW_ANONYMOUS_FALLBACK` to `false` — no page or
query changes.

### Features
- Orders table with search, filters and pagination.
- Field mapping editor: add, delete, enable/disable, reorder, change field,
  change transformation, live preview, auto-map suggestions.
- 13-transformation registry; adding one makes it immediately selectable.
- Saved configurations (named, reusable mapping sets) with apply/delete.
- Automation settings form; Settings page with all five required sections.
- Seeded demo workspace: 48 orders, 8 sync runs, 10 mappings.

---

## Phase 2 — eBay integration (code complete)

Real OAuth against eBay, real orders from the official **Sell Fulfillment
API**. Nothing is scraped. The app never sees an eBay password, and no token,
secret or eBay URL is ever sent to the browser.

### What was built

| Area | Detail |
| --- | --- |
| OAuth | `/api/auth/ebay/start` issues a CSRF `state` in an httpOnly cookie; `/api/auth/ebay/callback` validates it in constant time **before** spending the code, then exchanges server-side. |
| Token storage | AES-256-GCM, versioned (`v1:`), key derived from `AUTH_SECRET`. Tampering is detected; a rotated key fails closed. |
| Token lifecycle | Refresh within 2 minutes of expiry; concurrent refreshes collapse into one call; `invalid_grant` flips the connection to `EXPIRED` and the UI asks for a reconnect. |
| Disconnect / reconnect | Disconnect deletes stored tokens outright (imported orders are kept). Reconnect re-runs consent. |
| Order retrieval | Full pagination — 200/call, walks every offset, dedupes ids repeating across pages, reports `truncated` when a guard trips rather than silently returning a partial set. |
| Tracking | Second endpoint (`shipping_fulfillment`) under a per-run call budget, deferring the remainder to the next run. |
| Rate limiting | Per-connection serialisation with a minimum gap; exponential backoff with jitter; `Retry-After` honoured; 429 starts a cooldown persisted to `rateLimitedUntil`. |
| Normalization | Every field read through a tolerant helper. Malformed orders degrade to partial records; an order with no id is counted as unusable, not guessed at. |
| Error handling | 10 error categories, each mapped to an actionable message. A blocked import is a recorded `FAILED` job with logs, not an HTTP error. |
| Privacy | Buyer name, email, phone, street, postcode and tracking masked by default — including inside the raw-payload panel. `?reveal=1` unmasks. |

### Data captured per order
Order ID, legacy ID, sales record ref, marketplace, dates, derived status,
cancel/payment/fulfillment state, buyer (where eBay permits), subtotal,
shipping, tax, discount, total, currency, payment methods, full shipping
address, ship-by and delivery estimates, per-line SKU / item ID / title /
variation / quantity / unit price / line tax / line shipping / fulfillment
status, and every shipment with tracking number and carrier.

> The Fulfillment API has **no single order-status field**. The status the UI
> filters on is *derived* from cancellation + payment + fulfillment state, with
> all three stored verbatim alongside it.

### UI added
- Orders: SKU and marketplace filters alongside search/date/status; per-row
  links; live-vs-demo counts.
- Order detail page: order, buyer, payment, shipping, line items, tracking,
  and raw API data in a collapsed Advanced section.
- Settings → eBay: username, marketplace, connection status, token status with
  expiry, last successful API request, last error, rate-limit state, a **Test
  connection** button, and the last 8 API calls.
- Dashboard: token health and last successful API call.

---

## Phase 3 — Google integration (code complete)

Real OAuth against Google, with the destination chosen from the user's actual
Drive. The app never sees a Google password, and no credential reaches the
browser.

### What was built

| Area | Detail |
| --- | --- |
| OAuth | `/api/auth/google/start` and `/api/auth/google/callback`, mirroring the eBay routes. `access_type=offline` + `prompt=consent` so a refresh token is reliably issued. |
| Scope verification | Google lets a user untick individual permissions. The callback checks what was actually **granted** and refuses to save a connection that cannot list files or read values. |
| Token storage | AES-256-GCM, same helper as eBay. |
| Token refresh | Within 2 minutes of expiry; concurrent refreshes collapse into one; Google does not rotate refresh tokens, so the stored one is preserved. |
| Disconnect | Calls Google's revoke endpoint first, then deletes the local tokens, so the app disappears from the account's third-party permissions. |
| Spreadsheet selector | Search by name, refresh the list, and an advanced field that accepts a raw Spreadsheet ID **or** a pasted Sheets URL. |
| Worksheet selector | Lists every tab with its name, numeric worksheet ID, grid dimensions and frozen-row count. |
| Header configuration | Header row and first data row, validated so data cannot start at or above the header. |
| Header reading | Reads the real header row and displays it column-by-column with its spreadsheet letters. Trailing blanks are dropped; interior blanks and duplicates are reported. |
| Three tests | Test Google Connection / Spreadsheet / Worksheet, each returning a definite pass/fail plus the specific facts behind it. |
| Rate limiting | The eBay limiter was extracted to `src/lib/http/rate-limit.ts` and is now shared, with per-provider key namespacing. |

### Safety

The brief's requirements are enforced by
[`src/lib/sheets/write-plan.ts`](src/lib/sheets/write-plan.ts), rendered as a
**Write plan** panel on the Google Sheet page:

- every mapped column resolved to a concrete column letter,
- every existing column that is *not* mapped, listed explicitly as untouched,
- mapped targets that do not exist yet, flagged as "would create",
- **blockers** for duplicate targets, no enabled mappings, or more than five
  new columns — the plan refuses to report `safe`.

Additionally, `src/lib/google/sheets.ts` contains no write call of any kind,
and metadata reads omit `includeGridData` so no cell values are transferred
when listing worksheets. Phase 4's writer will be a separate module that must
check `plan.safe` and write only the listed letters.

---

## Phase 4 — synchronization engine (code complete)

**Sync Now** now runs the full pipeline: eBay → retrieve orders → retrieve
line items and shipments → normalize → apply mapping → apply transformations
→ check duplicate → insert or update in Google Sheets → save the result.

### What was built

| Area | Detail |
| --- | --- |
| Engine | `planSync()` and `runSheetSync()` in [`sheet-sync.ts`](src/lib/sync/sheet-sync.ts) share one planning pass, so the preview a user confirms is produced by the code that performs the write. |
| Writer | [`sheets-write.ts`](src/lib/google/sheets-write.ts) is the only module that can modify a spreadsheet. |
| Duplicate protection | The key column is read **out of the live sheet** before every run and reconciled against the planned rows, so the guard holds even with a fresh database or a hand-edited sheet. |
| Sync modes | Append / Update / Append + update. |
| Row modes | One row per order, or one row per line item. |
| Date ranges | 24h, 7d, 30d, 90d, custom, and *since last successful sync* (default), with a one-hour overlap on the cursor. |
| Preview + confirm | A dry run reporting orders found, new, existing, rows to insert/update, and the exact fields that will be written. The first bulk sync into a destination is refused until confirmed. |
| Progress | Job id returned immediately; the UI polls phase, row counter and results. |
| Results | Found / inserted / updated / skipped / failed. |
| Change detection | A stored hash skips rows whose values are unchanged, so a repeat sync costs no API calls. |

### Safety

Three layers, each independently sufficient to prevent the failure mode the
brief is worried about:

1. The **write plan** refuses to report `safe` on duplicate targets, a missing
   or unmapped key column, or more than five columns needing creation.
2. **`planSync()`** will not write while any blocker stands.
3. The **writer** builds A1 ranges only from *contiguous runs of mapped
   columns*. Mapped A, B, D, E produce `A:B` and `D:E` — never `A:E` — so
   unmapped column C cannot be blanked. There is no `values.clear`, no delete,
   and no row-level write anywhere in the codebase.

In LINE_ITEM mode the engine verifies key uniqueness from the *actual planned
values* and refuses the run if any key repeats, rather than collapsing line
items onto one row.

### Failure isolation

Writes go out in batches of 50. A failed batch marks only its own rows failed,
records them against their orders, and the run continues — verified by a test
that fails one batch of 50 and asserts the remaining 10 rows still write. The
run stops early only for failures certain to affect every batch (expired auth,
missing scope, deleted sheet).

---

## Phase 5 — filters, rules, transformations (complete)

Everything below is configured from `/filters` and `/field-mapping` and
stored as data. Adding a SKU, marketplace, rule or transformation choice
never requires a code change.

### Filters

Order status (Paid / Awaiting payment / Shipped / Completed / Cancelled),
fulfillment (Unfulfilled / Partially / Fulfilled), marketplace, SKU (All /
Include / Exclude / contains / starts with / ends with, case-sensitive
optional), and optional hard date bounds.

Two decisions worth recording:

- **Selecting nothing means "all".** No "All" token is stored, so an empty
  selection is unambiguous rather than a special case.
- **Order-status options overlap deliberately** — eBay reports payment,
  fulfillment and cancellation independently, so one order can be both Paid
  and Shipped. Selections are OR-ed.

SKU filtering respects the row mode: in one-row-per-order mode an order
survives if *any* item matches, so a multi-item order is never partly lost;
in line-item mode each row is filtered on its own SKU.

### Rules

A flat list of conditions combined with ALL/ANY, plus four actions: skip the
row, import only matching rows (whitelist), set a column to a value, or build
the row with a different saved mapping set — which is the brief's
*IF marketplace = UK THEN use configuration X*.

Resolution order is explicit: a matching skip wins immediately; a whitelist
requires at least one match; SET_VALUE overrides accumulate with the later
rule winning; the last matching mapping-set rule decides. A rule with no
conditions never matches, so an unfinished rule is inert rather than
destructive. Each rule records how many rows it matched on the last run.

### Transformations

Grouped into Basic / Text / Numbers & dates / Logic / Combine. Added this
phase: combine fields, conditional value, separate prefix and suffix, number
formatting with separator styles, text cleanup (HTML, line breaks, repeated
spaces, emoji), find-and-replace, and join-list options (separator,
de-duplicate, cap with "+N more").

Combining needed more than the single mapped value, so transformations now
receive an optional context whose `resolve` reads any dot-path from the row.
It is injected by the caller, keeping `transformations.ts` free of sync-engine
imports.

### Multi-item handling

`computed.skuList` / `titleList` / `quantityList` (pre-joined),
`computed.skus` / `titles` / `quantities` (raw arrays for **Join list**),
`computed.itemSummary` (`2 × SKU — Title; …`), and `computed.rowKey`.

---

## Phase 6 — reliable background synchronization (complete)

### What was built

| Area | Detail |
| --- | --- |
| Queue | Database-backed (`SyncJob`), with claim, heartbeat, retry and reclaim primitives in [`queue.ts`](src/lib/jobs/queue.ts). |
| Two drivers | `npm run worker` (long-running) and `POST /api/jobs/tick` (serverless cron). Both call the same `tick()` and are safe together. |
| Frequency | 15m / 30m / 1h / 3h / 6h / daily presets, plus a custom interval from 5 minutes to a week. |
| Quiet hours | Timezone-aware, including windows that wrap midnight. |
| Incremental | Scheduled runs always use *since last successful sync*; the cursor advances only on success. |
| Crash recovery | A stale heartbeat returns both the job and the workspace mutex to the pool. |
| Failure suspension | After 5 consecutive failures the schedule pauses with a stated reason rather than retrying forever. |
| Dashboard | Last successful, last failed, next scheduled, and current status — with live phase and row counter while a run is in flight. |

### How concurrency is made safe

Claiming a job is a conditional update: `updateMany` with the expected status
in the `where` clause affects exactly one row or none, and the database picks
the winner.

That alone does **not** guarantee one sync per workspace — two requests can
each create their own job row and each win its own compare-and-swap. A
`SyncLock` row keyed by user id closes it: `create` succeeds for exactly one
caller, and the mutex is taken *before* the job is claimed.

> An earlier attempt resolved the winner *after* claiming, by comparing lock
> timestamps with an id tie-break. It failed under test: a caller whose rival
> has not yet committed sees no rival at all and claims unconditionally, so
> the tie-break could pick the side that had already returned "claimed".
> Taking the mutex first removes the ambiguity rather than arbitrating it.

### Failure handling

| Category | Behaviour |
| --- | --- |
| Rate limited, 5xx, network, lost worker | Retried, exponential backoff capped at an hour |
| Expired auth, missing scope, deleted sheet, configuration blocker | Failed immediately |
| Unexpected exception | Retried within the attempt budget |

`lastSuccessAt` and the incremental cursor advance **only** on a successful
run, so a failure can never look like a success or silently skip a window.
Retries cannot duplicate rows, because the engine re-reads the sheet's key
column on every attempt.

### Manual sync

Still runs inline in the web request, so **Sync Now works with no worker
process at all**. It takes the same mutex, so pressing it mid-scheduled-run
returns a clear 409 instead of producing two writers on one sheet.

---

## Verification

| Check | Result |
| --- | --- |
| `npm test` | **319/319 pass**, ~50s, no network required |
| `npm run build` | Clean — 35 routes compiled |
| Smoke test (production build) | **51/51 pass** — automation settings, tick security, concurrency guard, job polling, dashboard status |
| Worker end-to-end | `scripts/verify-worker.ts` — schedule became due, tick ran it, failure recorded as failure, mutex released |
| Sandbox eBay credentials against live eBay | **HTTP 200**, real application token issued |

> The sync engine has been verified against an in-memory fake spreadsheet that
> records every write, not against live Google — no Google Cloud credentials
> have been supplied yet. The fake exercises the real client, planner, dedupe
> and writer; only the network boundary is substituted.

Test suites:

| File | Covers |
| --- | --- |
| `tests/normalize.test.ts` | Safe readers, status derivation, complete / near-empty / deliberately malformed payloads, eBay filter grammar |
| `tests/security.test.ts` | Encryption round-trip, tamper detection, key rotation, constant-time state comparison, every masking rule |
| `tests/rate-limit.test.ts` | Backoff growth and clamping, `Retry-After`, cooldown scoping and expiry, pacing, HTTP→category classification |
| `tests/ebay-integration.test.ts` | Real eBay client, token manager, pagination walker and import pipeline against an isolated SQLite DB with the transport stubbed |
| `tests/google-units.test.ts` | Spreadsheet id/URL parsing, A1 quoting and escaping, Google's overloaded 403s, and every write-plan rule |
| `tests/google-integration.test.ts` | Real Google client, token manager, Drive listing and Sheets reads, likewise with the transport stubbed |
| `tests/sync-units.test.ts` | A1 range construction and its gap-splitting, order→row expansion, every date range |
| `tests/sync-integration.test.ts` | The whole engine against a fake spreadsheet: inserts, updates, duplicate protection, three sync modes, line-item mode, safety refusals, batch-failure isolation, filters, rules, preview accuracy |
| `tests/filters-rules.test.ts` | Every filter mode and rule operator, rule precedence, validation, and each new transformation |
| `tests/schedule.test.ts` | Interval clamping, timezone-aware quiet hours (incl. wrapping midnight), next-run computation, backoff, retry classification |
| `tests/worker-integration.test.ts` | The queue against a real database: dedupe races, exclusive claiming, the workspace mutex, stale-lock takeover, crash recovery, retry scheduling, due-schedule enqueuing |

The integration tests inject a fake transport rather than mocking the modules
under test, so everything below the network boundary is production code. They
cover a 450-order three-page walk, cross-page duplicates, retry on
429/5xx/network, no-retry on 401/403, non-JSON success bodies, the cooldown
short-circuit, refresh on expiry, `invalid_grant` handling, concurrent refresh
collapsing, a full import with tracking, re-import updating rather than
duplicating, and every blocked-import path.

**Bugs found and fixed by these tests:** the eBay marketplace header was not
defaulted from the connection; the eBay retry limit was read at module load so
it could not be configured; and both integration files initially shared one
test database, which raced because `node --test` runs files in parallel.

The Google tests specifically pin the behaviours most likely to regress:
apostrophe escaping in Drive queries and A1 ranges (a sheet named
`Dan's orders` breaks a naive implementation), trailing-blank trimming when
Sheets reports a 1000-column grid, duplicate-header detection, and the
quota-403-vs-permission-403 split.

---

## Open items

### 1. Production eBay credentials rejected — blocking

Cross-check run on 2026-09-21:

| Test | Result |
| --- | --- |
| Sandbox keys → sandbox endpoint | **200 OK** |
| Production keys → production endpoint | **401 `invalid_client`** |
| Production keys → sandbox endpoint | 401 (expected) |

The code, endpoints and Basic-auth encoding are therefore correct; eBay is
rejecting the production credential pair itself. The App ID and Cert ID are
internally consistent (the Cert embeds the App ID's hex chunk on both
keysets), so a transcription error is unlikely.

Most probable cause: **the production keyset is not activated yet.** eBay
issues production keys immediately but will not authenticate them until the
application clears production checks — business details, privacy policy URL,
and the API License Agreement.

To resolve, in order:
1. Check the developer account for a pending compliance / "complete your
   application" notice.
2. Reveal and re-copy the Cert ID (the portal masks it by default).
3. Rotate the Cert ID and retry with the fresh value.

### 2. RuName not yet created — blocking

Required for the consent flow regardless of item 1. It lives under **User
Tokens** on the keyset, and it is an opaque RuName string, **not** a URL —
eBay puts it in the `redirect_uri` parameter and resolves the real callback
itself. Its *auth accepted URL* must be
`http://localhost:3000/api/auth/ebay/callback`; eBay may require HTTPS, in
which case a tunnel is needed (no code change — the callback builds redirects
from the incoming origin).

### 3. Google credentials supplied — ready to connect for real

`GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are now set in `.env`. Nothing
has been connected with them yet, so the Google path is still only verified
against stubs and the demo fixture.

Before connecting, confirm in the Cloud console that:

1. **Google Sheets API** and **Google Drive API** are both enabled.
2. The OAuth consent screen lists your own account under **Test users** while
   the app is in *Testing*, or consent is refused.
3. The authorized redirect URI is exactly
   `http://localhost:3000/api/auth/google/callback` — a literal URL that must
   match character for character, unlike eBay's RuName.

Then: restart, **Google Sheet → Connect Google**, pick a spreadsheet and
worksheet, run the three tests, then **Preview sync** before confirming.

### 4. Sandbox is working and preserved

The sandbox pair authenticates successfully and is kept in `.env` as comments.
Switching back is a two-line edit and lets the whole OAuth flow be exercised —
though a sandbox account shows no real orders.

### 5. Credentials in conversation history

The production App ID and Cert ID were shared in chat. Rotating the Cert ID
once setup is complete is worth doing.

---

## Explicitly not built yet

- **Login screen.** Single-user mode via the `getCurrentUser()` fallback.
  Until it exists, do not expose this build publicly.
- **Notification delivery.** `notifyOnError` / `notifyOnSuccess` are stored
  and respected in the UI, but nothing is sent. The hook is the
  success/failure branches of `runClaimedJob`.
- **Cron expressions.** `AutomationSetting.cronExpression` exists in the
  schema but is unused; scheduling is interval-based plus quiet hours.

> Because of the anonymous fallback, this build should not be exposed publicly
> until sign-in lands.

---

## Resuming work

```bash
npm install
npm run setup     # generate + push schema + seed demo workspace
npm test          # 90 tests
npm run dev
```

```bash
npm run worker    # in a second terminal, to run scheduled syncs
```

Next actions, in order:
1. Connect Google (credentials are in place) and select a real spreadsheet.
2. Clear the eBay blockers above, then connect and run a live import.
3. Run **Preview sync**, check the reported columns, then confirm — this is
   the first time rows reach a real spreadsheet, and the step most worth
   watching.
4. Turn on automation, start `npm run worker`, and confirm a scheduled run
   lands. `npx tsx scripts/verify-worker.ts` forces one immediately.
5. Phase 7 — sign-in (`ALLOW_ANONYMOUS_FALLBACK = false`) and notification
   delivery.
