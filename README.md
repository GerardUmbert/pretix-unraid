# pretix-mcp

An MCP server for two specific pretix operations: looking up a ticket's
status/history, and invalidating + reissuing a ticket to the same
customer. Deliberately narrow — see
[pretix-unraid's plans/mcp-server.md](https://github.com/REPLACE_WITH_GITHUB_USERNAME/pretix-unraid/blob/master/plans/mcp-server.md)
for the design record and why broader coverage was scoped out.

## Tools

- **`pretix_get_ticket_status`** — given an order code, returns current
  status plus a timeline built from payments, refunds, and check-ins
  (pretix has no dedicated order-history API endpoint, so this is
  synthesized client-side).
- **`pretix_reissue_ticket`** — invalidates a ticket's current secret
  and issues a new one for the same order/position/customer, preserving
  check-in history. Irreversible — call with `confirm=false` first to
  preview.
- **`pretix_mark_order_paid`** / **`pretix_cancel_order`** — basic order
  state changes. Same `confirm=false` preview pattern.

## Setup

1. Build:
   ```sh
   npm install
   npm run build
   ```
2. Get a pretix API token: in the pretix admin UI, go to your
   organizer's Team settings, create a team with access to the
   event(s) you want this to manage, and generate an API token for it.
3. Set environment variables (e.g. in your MCP client's server config):
   - `PRETIX_BASE_URL` — e.g. `https://your-pretix-instance.example`
   - `PRETIX_API_TOKEN` — the token from step 2
   - `PRETIX_ORGANIZER` — your organizer slug
   - `PRETIX_EVENT` — (optional) default event slug, if you're mostly
     working with one event. Tools also accept `event` as a per-call
     override.

Never commit real values for these — same rule as the pretix-unraid
repo's `pretix.cfg` guidance.

## Adding to Claude Code

Add to your MCP server config (e.g. via `claude mcp add` or your
`settings.json`):

```json
{
  "mcpServers": {
    "pretix": {
      "command": "node",
      "args": ["/absolute/path/to/pretix-mcp/dist/index.js"],
      "env": {
        "PRETIX_BASE_URL": "https://your-pretix-instance.example",
        "PRETIX_API_TOKEN": "...",
        "PRETIX_ORGANIZER": "your-organizer-slug",
        "PRETIX_EVENT": "your-event-slug"
      }
    }
  }
}
```

## Testing against a local instance

The sibling `pretix-unraid` repo has a throwaway pretix test instance
(SQLite-backed, disposable) plus repo-local skills for resetting and
seeding it with test data — see that repo's `.claude/skills/` and
`AGENTS.md`. Point `PRETIX_BASE_URL` at that instance to develop against
real data without touching a production pretix.

## What this deliberately doesn't do

See `plans/mcp-server.md` in `pretix-unraid` for the full reasoning, but
in short: no vouchers, memberships, gift cards, webhooks, item/catalog
management, or bulk operations. This is scoped to ticket lookup and
reissue, not a general pretix admin console.
