# Use cases: managing tickets with pretix-mcp

This describes the day-to-day flows `pretix-mcp` (the sibling repo,
`../pretix-mcp`) supports, and how to develop/test against this repo's
local pretix instance while building or changing it. See
`plans/mcp-server.md` for the design rationale and API research behind
these tools.

## Flow 1: "What's the status of this ticket?"

**Ask**: "What's the status of order ABC12?" / "Has ticket ABC12 been
checked in yet?" / "Show me the history of order ABC12."

**Tool**: `pretix_get_ticket_status`

**Input**: the order code (e.g. `ABC12`). Organizer/event default from
`PRETIX_ORGANIZER`/`PRETIX_EVENT` env vars if not given explicitly.

**What it returns**:
- Current order status (`paid`, `pending`, `expired`, `canceled` — as a
  readable label, not the raw `p`/`n`/`e`/`c` code)
- Each position's attendee name and whether they're currently checked in
- A chronological timeline built from the order's placement, every
  payment/refund event, and every check-in/check-out scan

**Why there's no single "get history" call under the hood**: pretix
doesn't expose an order-audit-log endpoint over its REST API (confirmed
during planning — the admin UI's own history tab is powered by an
internal model that isn't surfaced publicly). The tool reconstructs the
timeline itself from data that *is* in the order response: `datetime`,
`payments[]`, `refunds[]`, and each position's `checkins[]`.

## Flow 2: "This ticket needs to be invalidated and reissued"

**Ask**: "Order ABC12's ticket was compromised/lost/needs reprinting —
invalidate it and issue a new one for the same customer."

**Tool**: `pretix_reissue_ticket`

**Input**: order code, plus `positionid` if the order has more than one
ticket in it. Always call once with `confirm: false` first (or just omit
`confirm`/leave it false) — the tool returns a preview of exactly which
attendee/position would be affected without changing anything. Re-call
with `confirm: true` to actually perform it.

**What happens**: the position's ticket secret (the value encoded in its
QR/barcode) is regenerated. The **old secret stops working immediately**
— scanning it at a door returns "invalid," confirmed by direct testing,
not assumed from docs. The **new secret is valid** and tied to the exact
same order, position, and customer — check-in history from before the
reissue is preserved, so "was this attendee already inside" stays
correct across the swap.

**This is irreversible.** There's no "undo reissue" — if the wrong
position gets reissued, the fix is to reissue it *again* (which is safe
to do, tested), not to reverse anything.

## Flow 3: basic order bookkeeping

**Ask**: "Mark order ABC12 as paid" / "Cancel order ABC12."

**Tools**: `pretix_mark_order_paid`, `pretix_cancel_order`

Same `confirm: false` → preview → `confirm: true` → act pattern as
reissue. These are thin wrappers around pretix's own
`mark_paid`/`mark_canceled` order actions — no extra logic beyond
previewing the order's current state first.

## What's deliberately NOT covered

Vouchers, memberships, gift cards, webhooks, item/catalog management,
event creation, bulk operations — none of this is in scope. See
`plans/mcp-server.md`'s "Why / actual use cases" section for the reasoning:
the tool is scoped to ticket lookup and reissue, not general pretix
administration. If a real need for more comes up, that's a deliberate,
separate expansion — not something to guess at ahead of time.

## Developing / testing this locally

The pretix instance in this repo (`pretix-standalone.xml` /
`Dockerfile`) is the target to develop `pretix-mcp` against. Three
repo-local skills automate the loop:

1. **`pretix-reset`** — wipes the local test instance back to empty
   (destroys and recreates the container + volume).
2. **`pretix-seed`** — populates it: superuser, API token, a test
   organizer/event/item/quota, and one paid, checked-in test order.
   Prints the token and order code you need for the next steps.
3. **`pretix-test`** — runs real HTTP assertions against the seeded
   instance, including the specific regenerate_secrets → old-secret-
   invalid behavior that `pretix_reissue_ticket` depends on. This is
   what would catch it if a future pretix version changes that
   behavior.

Typical loop when changing `pretix-mcp`:

```sh
# from pretix-unraid/
bash scripts/pretix-api/reset.sh
node scripts/pretix-api/seed.mjs
# copy the printed PRETIX_API_TOKEN / order code

# from pretix-mcp/
npm run build
# point your MCP client (or a manual stdio driver) at dist/index.js
# with PRETIX_BASE_URL/PRETIX_API_TOKEN/PRETIX_ORGANIZER/PRETIX_EVENT
# set from the seed output, then exercise the tools against the real
# seeded order code.
```

Or, to just confirm pretix's own API still behaves as `pretix-mcp`
assumes (without touching `pretix-mcp` at all):

```sh
node scripts/pretix-api/seed.mjs
PRETIX_API_TOKEN=<printed token> node scripts/pretix-api/test.mjs
```
