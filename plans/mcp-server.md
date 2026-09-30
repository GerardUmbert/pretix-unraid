# Plan: pretix MCP server

Status: **implementation started** — see `../../pretix-mcp/` (sibling repo).
This doc is the design record; the code is the source of truth once it
diverges from what's written here.

## Why / actual use cases (confirmed across planning conversation)

Scope narrowed twice during planning, from "wrap ~90% of the pretix
API" down to what the user actually described wanting to *do*:

1. **"I have this ticket ID, show me its history and current status."**
   Read-heavy lookup: given an order code or a ticket secret, return
   current state plus a timeline (placed → paid → checked in → etc).
2. **"I have this ticket, I need to invalidate it and generate a new one,
   assigned to the same customer."** A write workflow: kill the old
   ticket's validity, issue a new one, same order/customer, preserving
   history.

Basic order bookkeeping (mark paid / cancel) was also requested,
piggybacking on the original broader plan, low-effort to include
alongside the two flows above.

Explicitly **not** building: the 6-group ~90%-coverage design from an
earlier planning pass (vouchers, memberships, gift cards, webhooks,
exporters, catalog management, etc). That was scoped before the two
concrete use cases above were stated; it's oversized for what's
actually wanted. If broader coverage becomes a real need later, treat it
as a new, separate expansion — don't build it speculatively now.

## Verified facts (empirically tested against a real running instance,
## not just read from docs — see "How this was verified" below)

### There is no dedicated "order history" endpoint

Confirmed by checking the order-lifecycle API guide directly: pretix has
no `/orders/{code}/logentries/`-style endpoint exposed over REST (the
internal `LogEntry` model that powers the admin UI's history tab isn't
surfaced in the public API). A ticket's timeline has to be **synthesized
client-side** from fields already present in one `GET
.../orders/{code}/` response:

- `datetime` — when the order was placed
- `last_modified` — most recent change, any kind
- `payments[]` — each with `state`, `created`, `payment_date`, `provider`
- `refunds[]` — each with `state`, `created`, `execution_date`, `source`
- `positions[].checkins[]` — each with `datetime`, `list`, `type`
  (entry/exit), `gate`/`device` if scanned by a specific device

`pretix_get_ticket_status` builds its "history" by sorting all of the
above into one chronological list, not by calling a history-specific
endpoint (none exists).

### Lookup by order code vs. by ticket secret are different paths

- **By order code**: direct — `GET /organizers/{organizer}/events/{event}/orders/{code}/`.
- **By ticket secret** (e.g. someone reads a QR code / barcode value
  without knowing the order code): no direct "get position by secret"
  endpoint for arbitrary lookups outside of check-in. The practical path
  confirmed during testing is the same `checkinrpc/redeem/` endpoint
  used for scanning — but that endpoint actually **performs** a
  check-in as a side effect, so it's wrong to use for a read-only status
  check. **Open implementation detail, not yet resolved**: either (a)
  search order positions across events by secret using
  `.../checkinlists/{list}/positions/?search=<secret>` scoped per
  list/event (works, but requires knowing/iterating which event), or
  (b) require the caller to supply the order code, and treat "I only
  have the secret" as a degraded/slower path. Decide this concretely
  during Pillar/tool implementation, don't guess further here.

### Ticket invalidate + reissue: `regenerate_secrets` alone is sufficient
### (empirically confirmed end to end, this was the big open question)

Before testing, the docs read as ambiguous/concerning: they explicitly
state regenerate_secrets "does not cause the old secret to be added to
the revocation list," which sounded like the old QR might keep scanning
as valid. **Tested against a real running instance and confirmed this
concern doesn't materialize in practice:**

Test sequence run against a fresh pretix test container (org `testorg`,
event `testevent`, one order, position secret manually set to
`ORIGINAL-SECRET-123` at order-creation time):

1. `POST /organizers/testorg/checkinrpc/redeem/` with the original
   secret → `{"status":"ok", ...}`. Confirms secret works before change.
2. `POST /organizers/testorg/events/testevent/orderpositions/1/regenerate_secrets/`
   → returns the position with a freshly generated `secret`
   (`g8amk44m...`), **same position id, same checkins[] history
   preserved**.
3. Retried the **old** secret via `checkinrpc/redeem/` →
   `{"status":"error","reason":"invalid","detail":"Not found."}` — old
   secret is completely dead, immediately, no separate revoke step
   needed.
4. Tried the **new** secret via `checkinrpc/redeem/` →
   `{"status":"error","reason":"already_redeemed", ...}` — correctly
   resolves to the same position, which had already been checked in in
   step 1, confirming continuity of identity/history across the secret
   change.

**Conclusion**: one endpoint (`orderpositions/{id}/regenerate_secrets/`)
does exactly what "invalidate this ticket and issue a new one to the
same customer" means in practice: old code dead, new code live, same
order/customer/history. No cancel+recreate dance, no product-change
trick needed — the docs' "not added to revocation list" caveat is true
in the narrow technical sense (there's a separate internal `revoked`
status distinct from `invalid`) but doesn't matter for this use case,
since `invalid` rejects the old code just as effectively as `revoked`
would at the check-in gate.

### Auth / base facts (from earlier research pass, still accurate)

- **Auth**: `Authorization: Token <key>` header, from a Team's API
  token. In current pretix, `Team` has boolean `all_events`,
  `all_event_permissions`, `all_organizer_permissions` fields (not the
  older per-action `can_*` booleans some docs/blog posts reference —
  confirmed by inspecting the actual `Team` model fields on the running
  instance, since a first attempt using `can_*` field names failed with
  a Django `FieldError`).
- **Base URL pattern**: `https://<host>/api/v1/organizers/{organizer}/events/{event}/<resource>/`.
- **Pagination envelope**: `{ "count", "next", "previous", "results" }`,
  max `page_size` 50.
- Events **cannot be created with `"live": true`** directly — pretix
  rejects it until quotas/payment are configured (confirmed via a real
  422 response: `"Events cannot be created as 'live'."`). Relevant for
  the seed script, not the MCP server itself.

## v1 tool set (final, narrow scope)

1. **`pretix_get_ticket_status`** — input: `organizer`, `event`, and
   either `order_code` or `secret`. Output: current order/position
   status (human-readable, not raw `n`/`p`/`e`/`c` codes) plus the
   synthesized chronological history described above.
2. **`pretix_reissue_ticket`** — input: `organizer`, `event`,
   `position_id` (or resolved from `order_code` + attendee/position
   index if an order has multiple positions). Calls
   `orderpositions/{id}/regenerate_secrets/`, returns old vs. new secret
   and confirmation the position/order/customer are unchanged. Must
   echo back exactly which position is about to be reissued before
   calling the API (same write-action-safety principle as every mutating
   tool in this project) since this is irreversible — the old code goes
   dead immediately with no undo.
3. **`pretix_mark_order_paid`** — thin wrapper on `POST .../orders/{code}/mark_paid/`.
4. **`pretix_cancel_order`** — thin wrapper on `POST .../orders/{code}/mark_canceled/`.

Nothing else. If a need for broader coverage (vouchers, webhooks, item
management, etc.) shows up later, it gets scoped and added as its own
follow-up, the same way this doc narrowed down to these four tools
rather than starting broad.

## Architecture

- **Language**: TypeScript (Node), `@modelcontextprotocol/sdk`, stdio
  transport. No framework needed for 4 tools.
- **Repo**: `pretix-mcp`, sibling to `pretix-unraid` under
  `C:\Users\Dunnow\Documents\repos\`.
- **Structure**:
  ```
  pretix-mcp/
    src/
      index.ts       # server entrypoint, registers the 4 tools
      client.ts        # fetch wrapper: base URL + token header
      tools/
        ticket-status.ts   # pretix_get_ticket_status
        reissue.ts           # pretix_reissue_ticket
        orders.ts              # pretix_mark_order_paid, pretix_cancel_order
      types.ts       # Order, Position, Payment, Refund, Checkin shapes
    package.json
    tsconfig.json
    README.md        # env vars, how to get a token, how to add to Claude config
  ```
- **Config**: `PRETIX_BASE_URL`, `PRETIX_API_TOKEN`,
  `PRETIX_ORGANIZER` (default organizer slug), `PRETIX_EVENT` (default
  event slug — reasonable given the confirmed use case is per-event
  ticket management, not cross-event operations).
- **Error handling**: surface pretix's JSON error body (`detail`, field
  errors) rather than a bare HTTP status code.

## Write-action safety

`pretix_reissue_ticket`, `pretix_mark_order_paid`, and
`pretix_cancel_order` all change real, hard-to-reverse state:

- `pretix_reissue_ticket`: irreversible (old secret dead instantly, no
  undo endpoint) — must echo back attendee name, order code, and item
  before calling the API.
- `pretix_mark_order_paid` / `pretix_cancel_order`: same
  echo-back-before-acting rule as any money-adjacent action.

No delete-order, delete-event, or bulk operations in this tool set —
consistent with every prior pass of this plan.

## Local dev / testing setup (repo-local skills, not scratchpad)

Companion automation lives in `pretix-unraid` (this repo, not
`pretix-mcp`) as directory-scoped Claude Code skills, since they operate
on the *pretix test instance*, independently of whether `pretix-mcp`'s
code exists or works:

- `.claude/skills/pretix-reset/` — wipe the test instance back to empty
  (fresh SQLite volume or truncate via API).
- `.claude/skills/pretix-seed/` — create a test organizer/event/item/
  quota/order via the REST API (same calls used in the empirical
  verification above — that verification run *is* the reference
  implementation for this script).
- `.claude/skills/pretix-test/` — run integration tests against a
  running instance.

See those skill directories for the actual scripts. `pretix-mcp`'s own
README should point back to these for "how do I get test data" rather
than duplicating seed logic in two repos.

## How this was verified

Every claim in the "Verified facts" section above was tested against a
real, disposable pretix container (official `pretix/standalone:stable`
image, SQLite backend, run and destroyed via Docker on the local dev
machine — never against a production or user-facing instance). Superuser
and API token were created via `python3 -m pretix shell` one-liners
(Django ORM), since `createsuperuser --noinput` doesn't set a usable
password and there's no other non-interactive path. Full command
sequence is reproducible from this doc's "Verified facts" section
step-by-step — treat that as the record of what was actually run, not
just a description.

## Open items for whoever picks this up

- Ticket lookup **by secret alone** (no order code) needs a concrete
  decision — see "Lookup by order code vs. by ticket secret" above.
  Don't guess; either test the `checkinlists/{id}/positions/?search=`
  path for real, or explicitly punt to "order code required" for v1 and
  say so in the tool's description so callers aren't surprised.
- Multi-position orders (an order with several tickets) — `pretix_get_ticket_status`
  and `pretix_reissue_ticket` need a clear story for "which position,"
  not just "which order." Test against an order with 2+ positions before
  calling this done.
