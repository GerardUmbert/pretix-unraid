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

## Flow 4: transferring a ticket to someone else

**Ask**: "Transfer the ticket on order ABC12 to Ana Ruiz, ana@example.com."

**Tool**: `pretix_transfer_ticket`

Changes the attendee name/email on one ticket, optionally the order's
contact email, and by default reissues the QR so the previous holder's
copy stops working. Preview first with `confirm: false`. A ticket cannot
be moved to a different order through pretix's API; the order stays with
the original buyer.

## How this fits with the real integration

The MCP is a **backoffice helper**: it lets staff trace ticket flow and
history and set things up quickly (events, items, quotas, check-in lists,
test orders). It is not the production path. A custom app is expected to
talk to pretix's REST API directly: send in orders, get back tickets
(secrets/QR values and ids), and request changes such as transfers.

- **Customer accounts are not needed.** Orders carry their own buyer
  email and per-ticket attendee name/email, and transfers work on those.
  The customer tools (`pretix_create_customer`, `pretix_update_customer`,
  `customer_id` on order creation) exist, but nothing here depends on
  them; skip them unless a shop-with-logins setup is wanted.
- **Change notifications come from pretix, not the MCP.** Because any
  client (the MCP or the custom app) can make a change, the webhook is
  pretix's own. Verified against a real instance: a holder change logs
  `pretix.event.order.modified`, a QR reissue logs
  `pretix.event.order.changed.secret` (subscribe with the wildcard
  `pretix.event.order.changed.*`), and an order-email change logs
  `pretix.event.order.contact.changed`. Subscribe a webhook to those (plus
  `pretix.event.order.placed`/`.paid` if useful).
- **Webhook targets must be publicly routable.** pretix refuses to call
  private, loopback, link-local and CGNAT (100.64.0.0/10, so Tailscale
  IPs too) addresses (`pretix/helpers/ssrf.py`, no config switch). A
  receiver on a LAN IP or a Tailscale address will fail with "Request to
  private address ... blocked". Use a public hostname (e.g. a Funnel URL).
- **Payment providers can't be enabled via the API**, only in the web UI.
  Orders created through the API as paid need none; only a shop that sells
  paid tickets directly needs one to go live.

## Scope

Beyond ticket lookup and reissue, the MCP now also covers events,
items/categories/quotas, check-in lists, orders, vouchers, customers,
webhooks and devices (see `mcp/README.md`). It still does not manage
payment providers, backend users/teams, or invoices.

## Developing / testing this locally

The pretix instance in this repo (`my-pretix-standalone.xml` /
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
