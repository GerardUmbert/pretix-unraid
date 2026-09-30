# Plan: pretix MCP server

Status: **expanding from 4 tools to ~90% coverage** — 4 tools exist and
are verified working (`mcp/src/`); this doc describes the target to
build toward next: the 6 tool groups below. This doc is the design
record; the code is the source of truth once it diverges from what's
written here.

## Why (scope history, so the back-and-forth isn't lost)

This plan changed scope twice, and the second change was later reverted
— worth recording precisely so it doesn't happen a third time by
accident:

1. First pass: ~15 tools across 5 curated pillars (events, items/quotas,
   orders, check-in, order-creation-for-sync).
2. User asked "what if I wanted 90%" → rewritten to 6 tool groups,
   ~60-90 tools (this doc's current target).
3. User then described two specific real use cases in concrete terms
   ("show me this ticket's history," "invalidate and reissue this
   ticket to the same customer") → scope was narrowed down to just 4
   tools built around those two flows plus basic mark-paid/cancel. This
   version was **fully implemented and verified** end-to-end over real
   MCP stdio JSON-RPC against a live pretix instance.
4. User then clarified: the 90% target from step 2 is what they
   actually want kept as the goal — the 4-tool narrowing wasn't meant to
   replace it permanently. This doc now reflects that: **build toward
   90% coverage**, keeping the 4 already-built tools as the first slice
   of it rather than throwing them away.

Lesson for whoever picks this up: when a user says "what if I wanted X"
and then later describes narrower concrete asks, don't assume the
narrower asks replace X — check whether they're a first phase of X or a
full scope change. This doc's own history is the cautionary example.

## Already built and verified (don't redo)

Location: `mcp/src/` in this repo (merged in via `git subtree` from a
formerly-separate `pretix-mcp` repo — history preserved, browsable with
`git log --follow` inside `mcp/`).

- `pretix_get_ticket_status` — order lookup + synthesized history
- `pretix_reissue_ticket` — invalidate + reissue via `regenerate_secrets`
- `pretix_mark_order_paid` — thin wrapper on `mark_paid`
- `pretix_cancel_order` — thin wrapper on `mark_canceled`

All 4 were driven over real MCP stdio JSON-RPC against a live,
disposable pretix test container (not mocked) — see "Verified facts"
below for the empirical findings that came out of building them. These
map onto the `orders` and part of the `checkin` groups below — don't
rebuild them, extend the existing files (`mcp/src/tools/orders.ts`,
`mcp/src/tools/reissue.ts`, `mcp/src/tools/ticket-status.ts`).

## Target: ~90% coverage, 6 tool groups

pretix's REST API has ~40+ resource types. Wrapping literally all of it
(seating-plan geometry, GDPR data shredders, pretix Hosted billing
internals, raw team/API-token minting) would add tools nobody asked for
and some that are actively dangerous to expose to an agent. "90%"
deliberately excludes that dangerous/rare 10% — see "Explicitly out of
scope" below — while covering everything someone actually does running
an event day to day.

**Tool count reality**: ~60-90 individual MCP tools across all 6 groups.
That's enough to hurt tool-selection quality and burn context budget if
all of it loads into every session at once, so tools are organized into
groups the user can enable selectively (mechanism: `PRETIX_TOOL_GROUPS`
env var, comma-separated, e.g. `core,orders,checkin` — filters which
tools get registered at server startup in `mcp/src/server.ts`).

| Group | Covers | Status |
|---|---|---|
| `orders` | Orders, payments, refunds, order state actions | Partially built (mark_paid, cancel, reissue) |
| `checkin` | Check-in lists, redeem/scan, check-in status | Partially built (reissue touches this) |
| `core` | Events, items, categories, tax rules, quotas (read + write) | Not started |
| `sales` | Vouchers, discounts, gift cards | Not started |
| `crm` | Customers, memberships, membership types | Not started |
| `admin` | Webhooks, exporters, devices | Not started |

Build order: finish `orders` and `checkin` properly first (since
they're partially done and most load-bearing), then `core`, then
`sales`/`crm`/`admin` in whatever order comes up as a real need.

## Explicitly out of scope (the other ~10%)

Excluded deliberately, not by oversight:

- **Data shredders** (GDPR deletion) — irreversible, high-consequence,
  no real case for an agent doing this unattended.
- **Team / API token management** — an agent that can mint its own API
  tokens can escalate its own access; this must stay a human-only action
  in the pretix UI.
- **Seating plan editing** (geometry/layout) — read-only seat
  availability belongs in `checkin`/`core`; designing a seating chart is
  a visual task with no sane text/tool representation.
- **pretix Hosted billing internals** — not applicable to a self-hosted
  instance, which is what this is planned against.
- **Organizer-level settings / plugin enable-disable** — changing which
  plugins are active on an event is closer to infrastructure config than
  an operational action; leave to the UI.
- **Event create/clone/delete** — kept out even though technically
  common, because it's infrequent (once-per-event, not once-per-day) and
  destructive on the delete side. Revisit only if this specifically
  becomes a real pain point.

## Verified facts (empirically tested against a real running instance)

### There is no dedicated "order history" endpoint

pretix has no `/orders/{code}/logentries/`-style endpoint exposed over
REST (the internal `LogEntry` model that powers the admin UI's history
tab isn't surfaced in the public API). A ticket's timeline has to be
synthesized client-side from fields already present in one `GET
.../orders/{code}/` response: `datetime`, `last_modified`, `payments[]`,
`refunds[]`, `positions[].checkins[]`. This is what
`pretix_get_ticket_status` already does (`mcp/src/tools/ticket-status.ts`).

### Ticket invalidate + reissue: `regenerate_secrets` alone is sufficient

Tested end to end against a real disposable pretix container: redeeming
a ticket's secret, calling `orderpositions/{id}/regenerate_secrets/`,
then confirming the **old** secret is rejected (`reason: "invalid"`)
immediately and the **new** secret resolves to the same position with
check-in history intact (`reason: "already_redeemed"`, matching the
earlier check-in). One endpoint does the whole job — no cancel+recreate
needed. This is what `pretix_reissue_ticket` already does.

### Auth / base facts

- **Auth**: `Authorization: Token <key>` header, from a Team's API
  token, created manually in the pretix admin UI (Team settings → API
  keys) — no API for minting the first token.
- `Team` model has boolean `all_events`, `all_event_permissions`,
  `all_organizer_permissions` fields — NOT the older per-action `can_*`
  booleans some docs/blog posts reference (confirmed by inspecting the
  real model; a first attempt using `can_*` names failed with a Django
  `FieldError`).
- `User` model has no `is_superuser` field, only `is_staff`.
- `createsuperuser --noinput` doesn't set a usable password — for
  scripted setup, create the user via `python3 -m pretix shell` and
  call `.set_password()` directly (see `scripts/pretix-api/seed.mjs`).
- **Base URL pattern**: `https://<host>/api/v1/organizers/{organizer}/events/{event}/<resource>/`.
  Organizer-level resources (webhooks, vouchers' parent organizer,
  cross-event order listing) drop the `/events/{event}/` segment.
- **Pagination envelope**: `{ "count", "next", "previous", "results" }`,
  max `page_size` 50.
- Events **cannot be created with `"live": true`** directly — pretix
  rejects it with a 400 until quotas/payment are configured.
- **No generic bulk/batch endpoint** for most resources — one object per
  create/update/delete request. Confirmed exception: vouchers have
  `batch_create/`. Don't assume batch support exists elsewhere without
  checking that specific resource's docs first.

## Group details

### `orders` (partially built)

| Action | Method + path | Status |
|---|---|---|
| List orders | `GET .../orders/` (or organizer-level for cross-event) | Not built |
| Get order | `GET .../orders/{code}/` | Built (inside ticket-status) |
| Create order | `POST .../orders/` | Not built |
| Mark paid/pending/canceled/expired | `POST .../orders/{code}/mark_paid\|mark_pending\|mark_canceled\|mark_expired/` | paid + canceled built |
| Approve/deny | `POST .../orders/{code}/approve/`, `.../deny/` (deny takes `send_email`, `comment`) | Not built |
| Reactivate | `POST .../orders/{code}/reactivate/` | Not built |
| Extend deadline | `POST .../orders/{code}/extend/` | Not built |
| Download ticket | `GET .../orders/{code}/download/{output}/` (409 if not ready) | Not built |
| List/get refunds | `GET .../orders/{code}/refunds/`, `.../refunds/{local_id}/` | Not built |
| Create refund | `POST .../orders/{code}/refunds/` — manual-refund path, **does NOT validate amount against what's owed** (confirmed in docs) — tool must do that check itself | Not built |

Order creation fields worth calling out (for external-ticket-sync use
cases): `code` (custom order code), `status` (can set to `p` directly),
`positions[].secret` (custom QR/barcode value — lets an external system
that generates its own ticket IDs keep them unchanged in pretix),
`positions[].attendee_name`, `send_email` (require explicit, don't rely
on default — wrong value double-emails a real attendee).

New tools needed: `pretix_list_orders`, `pretix_create_order`,
`pretix_mark_order_pending`, `pretix_mark_order_expired`,
`pretix_approve_order`, `pretix_deny_order`, `pretix_reactivate_order`,
`pretix_extend_order`, `pretix_download_ticket`, `pretix_list_refunds`,
`pretix_issue_refund` (highest-risk tool in the whole set — see
write-action safety below).

### `checkin` (partially built)

| Action | Method + path | Status |
|---|---|---|
| Redeem by secret | `POST /organizers/{organizer}/checkinrpc/redeem/` — body `{secret, lists: [...]}` | Used internally by reissue verification, not exposed as its own tool |
| List check-in lists | `GET .../events/{event}/checkinlists/` | Not built |
| Check-in list status | `GET .../checkinlists/{id}/status/` — `checkin_count`, `position_count`, `inside_count` | Not built |
| List positions on a list | `GET .../checkinlists/{list}/positions/` — supports `search=` | Not built |

Redeem response `status`/`reason` values: `ok`, `invalid`, `unpaid`,
`blocked`, `invalid_time`, `canceled`, `already_redeemed`, `product`,
`rules`, `ambiguous`, `revoked` — map each to plain English in tool
output (already done this way in the existing reissue-verification
logic; reuse that mapping).

New tools needed: `pretix_list_checkin_lists`,
`pretix_get_checkin_status`, `pretix_list_checkin_positions`,
`pretix_checkin_by_secret` (the actual scan-and-redeem action, distinct
from `pretix_reissue_ticket`'s internal use of the same endpoint).

**Resolve this before building `pretix_checkin_by_secret`**: is there a
way to look up a ticket by secret alone (read-only, no side effect) for
`pretix_get_ticket_status`'s benefit? The redeem endpoint performs a
check-in as a side effect, so it's wrong for a pure lookup. Untested
candidate: `checkinlists/{list}/positions/?search=<secret>`. Test this
for real before deciding; don't guess.

### `core` (not started)

| Action | Method + path |
|---|---|
| List/get events | `GET .../events/`, `.../events/{event}/` (read-only — event create/clone/delete out of scope) |
| List/get/create/update items | `GET`/`POST`/`PATCH .../events/{event}/items/[{id}/]` |
| List/get/create categories | `GET`/`POST .../events/{event}/categories/[{id}/]` |
| List/get tax rules | `GET .../events/{event}/taxrules/` |
| List/get/create/update quotas | `GET`/`POST`/`PATCH .../events/{event}/quotas/[{id}/]` |
| Quota availability | `GET .../quotas/{id}/availability/` — includes paid/pending counts, cart holds, blocking vouchers, waiting list count; surface the whole breakdown, not just raw `size` |

Tools: `pretix_list_events`, `pretix_get_event`, `pretix_list_items`,
`pretix_get_item`, `pretix_create_item`, `pretix_update_item`,
`pretix_list_categories`, `pretix_create_category`,
`pretix_list_tax_rules`, `pretix_list_quotas`,
`pretix_get_quota_availability`, `pretix_create_quota`,
`pretix_update_quota`.

### `sales` (not started)

| Action | Method + path |
|---|---|
| List/get/create/update/delete vouchers | `GET`/`POST`/`PATCH`/`DELETE .../events/{event}/vouchers/[{id}/]` |
| Batch-create vouchers | `POST .../events/{event}/vouchers/batch_create/` — the one confirmed bulk endpoint in the whole API |
| List/get discounts | `GET .../events/{event}/discounts/` |
| List/get gift cards | `GET /organizers/{organizer}/giftcards/` (organizer-level) |

Voucher fields: `code`, `max_usages` (default 1), `value`, `price_mode`
(`none`/`set`/`subtract`/`percent`), `valid_until`,
`item`/`variation`/`quota`/`seat` restriction, `tag`, `redeemed`
(read-only), `block_quota`, `allow_ignore_quota`.

Tools: `pretix_list_vouchers`, `pretix_get_voucher`,
`pretix_create_voucher`, `pretix_batch_create_vouchers`,
`pretix_update_voucher`, `pretix_delete_voucher`,
`pretix_list_discounts`, `pretix_list_gift_cards`.

### `crm` (not started)

| Action | Method + path |
|---|---|
| List/get customers | `GET /organizers/{organizer}/customers/` |
| List/get memberships | `GET /organizers/{organizer}/customers/{id}/memberships/` |
| List membership types | `GET /organizers/{organizer}/membershiptypes/` |

Lower research confidence than other groups — re-verify field
names/paths against the live API before implementing, not just from
this doc.

Tools: `pretix_list_customers`, `pretix_get_customer`,
`pretix_list_memberships`, `pretix_list_membership_types`.

### `admin` (not started)

| Action | Method + path |
|---|---|
| List/create/update/delete webhooks | `GET`/`POST /organizers/{organizer}/webhooks/`, `PATCH`/`DELETE .../webhooks/{id}/` |
| List devices | `GET /organizers/{organizer}/devices/` |
| Exporters | general trigger-job/poll/download pattern — confirm exact flow at implementation time, not assumed here |

Webhook fields: `target_url`, `enabled`, `all_events`, `limit_events`
(event slugs, used when `all_events` false), `action_types` (e.g.
`pretix.event.order.placed`, `pretix.event.order.paid`), `comment`.

**Known gap**: pretix's webhook docs describe no signature/HMAC
verification for payloads POSTed to `target_url`. A
`pretix_create_webhook` tool pointing at a user-controlled endpoint has
no documented way for that endpoint to verify the request's origin —
flag this to the user at implementation time; the receiver may need its
own secret-path-segment convention instead.

Tools: `pretix_list_webhooks`, `pretix_create_webhook`,
`pretix_update_webhook`, `pretix_delete_webhook`, `pretix_list_devices`.
Exporter tools: design pending the implementation-time doc check above.

## Write-action safety

Every mutating tool across all groups changes real state — money
bookkeeping, attendee admission, product catalog, promo codes, or
outbound integrations. Rules that apply across all of them (already
followed by the 4 existing tools, keep following for new ones):

- Every mutating tool echoes back exactly what it's about to do (which
  record, what fields change, which event/organizer) and requires an
  explicit `confirm: true` — the existing 4 tools' `confirm`-boolean
  pattern (`mcp/src/tools/reissue.ts`, `orders.ts`) is the template to
  copy for every new mutating tool, not a new pattern to invent per tool.
- `pretix_issue_refund` specifically must validate the amount against
  what's actually owed before calling the API, since pretix's own
  endpoint does **not** do that validation — this is the single
  highest-risk tool in the whole set.
- No delete tools for events, organizers, or anything under "Explicitly
  out of scope" — not deferred, excluded outright.
- `pretix_delete_voucher`/`pretix_delete_item`/`pretix_delete_category`
  are lower-consequence than order/refund mutations but should still
  echo back what's being deleted before calling the API.

## Architecture

- **Language**: TypeScript (Node), `@modelcontextprotocol/sdk`.
- **Transport**: stdio, confirmed working end-to-end. An HTTP/SSE
  transport (`mcp/src/http.ts`, using `StreamableHTTPServerTransport`)
  was attempted for "run this inside the same container as pretix on
  Unraid" but hit a real bug (malformed chunked-transfer-encoding
  response, reproducible, not yet root-caused) and was paused to
  prioritize this tool-coverage expansion instead. Pick that back up
  separately — don't let it block tool-group work, and don't remove
  `http.ts`/`server.ts` in the meantime, they're mid-fix, not abandoned.
- **Location**: `mcp/` inside this repo (`pretix-unraid`), NOT a
  separate repo — merged in in an earlier session via `git subtree`
  after initially being split out; don't re-split it.
- **Tool group filtering**: `PRETIX_TOOL_GROUPS` env var (comma-
  separated, e.g. `core,orders,checkin`), read at startup in
  `mcp/src/server.ts`, filtering which `registerTool` calls run. Not yet
  implemented — currently all 4 existing tools always register
  unconditionally. Add this as part of building out `core` (the next
  group), not as an afterthought once there are 90 tools to sort through.
- **Structure** (current + planned):
  ```
  mcp/src/
    index.ts        # stdio entrypoint
    http.ts         # HTTP entrypoint (paused, has a known bug)
    server.ts       # shared createServer() - tool registration lives here
    client.ts       # fetch wrapper: base URL + token header
    types.ts        # shared response shapes
    tools/
      ticket-status.ts   # built: pretix_get_ticket_status
      reissue.ts          # built: pretix_reissue_ticket
      orders.ts            # built: mark_paid, cancel — EXTEND with the rest of the orders group
      checkin.ts            # new: checkin group tools
      core.ts                 # new: events/items/categories/quotas
      sales.ts                  # new: vouchers/discounts/giftcards
      crm.ts                      # new: customers/memberships
      admin.ts                     # new: webhooks/devices/exporters
  ```
- **Config**: `PRETIX_BASE_URL`, `PRETIX_API_TOKEN`, `PRETIX_ORGANIZER`,
  `PRETIX_TOOL_GROUPS` (new). No `PRETIX_EVENT` default — the user
  manages multiple events concurrently, so every tool takes `event` as
  an explicit per-call parameter (already true for the 4 existing
  tools — keep this pattern, don't add an event default).
- **Error handling**: surface pretix's JSON error body (`detail`, field
  errors) rather than a bare HTTP status code — already done in
  `client.ts`'s `PretixApiError`, reuse it.

## Local dev / testing setup

Repo-local, not scratchpad — already built and verified:

- `scripts/pretix-api/reset.sh` — wipes the test instance
- `scripts/pretix-api/seed.mjs` — creates superuser/token/org/event/
  item/quota/order via the real REST API
- `scripts/pretix-api/test.mjs` — integration tests against a running
  instance (10/10 passing as of last run)
- `.claude/skills/pretix-reset/`, `pretix-seed/`, `pretix-test/` — Claude
  Code skills wrapping the above

Extend `test.mjs` as new tool groups get built — each group should gain
its own assertions the same way `orders`/`checkin` behavior is already
covered, not a separate untested pile of new endpoints.

## Open items

- HTTP transport bug (malformed SSE/chunked response) — paused, not
  abandoned. Revisit once tool-coverage work reaches a natural pause
  point, or sooner if "one container, everything running there" becomes
  the priority again.
- Ticket lookup by secret alone (no order code) — untested candidate
  endpoint noted under `checkin` above.
- Multi-position orders — `pretix_get_ticket_status` and
  `pretix_reissue_ticket` need testing against an order with 2+
  positions, not just the single-position case verified so far.
- `crm` group's field names/paths need re-verification against a live
  instance before implementation — lower confidence than other groups.
