# pretix-mcp

An MCP server covering most of what you'd do running a pretix event day
to day — orders, check-in, catalog/quotas, vouchers/gift cards,
customers/memberships, and webhooks/devices — organized into 6 tool
groups you can enable selectively. See
[../plans/mcp-server.md](../plans/mcp-server.md) for the design record,
what's deliberately excluded (data shredders, API token minting, event
create/delete, seating-plan editing), and the empirical findings behind
specific tools.

Lives inside the `pretix-unraid` repo (this is the `mcp/` subfolder) —
merged in from a formerly-separate `pretix-mcp` repo via `git subtree`,
history preserved. It's an independent Node project with its own
`package.json`; nothing here is baked into the pretix Docker image or
the Unraid template in the parent folder. **This server does not run on
the Unraid NAS.** It runs on whatever machine your AI client (e.g.
Claude Code) runs on, and talks to a pretix instance's REST API over
HTTP — that instance can be on the NAS, or the local throwaway test
instance from the parent repo.

## Tool groups

| Group | Covers | Always on? |
|---|---|---|
| — | `pretix_get_ticket_status`, `pretix_reissue_ticket` | Yes, unconditionally |
| `orders` | List/create orders, mark paid/pending/canceled/expired, reactivate, extend, approve/deny, refunds, ticket download | Default |
| `checkin` | Check-in lists, status, position search, check-in by secret | Default |
| `core` | Events (read-only), items, categories, tax rules, quotas | Opt-in |
| `sales` | Vouchers (incl. batch create), discounts, gift cards | Opt-in |
| `crm` | Customers, memberships, membership types | Opt-in |
| `admin` | Webhooks, devices | Opt-in |

Two tools — `pretix_get_ticket_status` and `pretix_reissue_ticket` —
are always registered regardless of `PRETIX_TOOL_GROUPS`; they predate
the group system and are this server's original, most-verified core.

Every mutating tool (create/update/delete/mark_*/etc.) requires an
explicit `confirm: true`; call it once without `confirm` (or with
`confirm: false`) first to preview exactly what it would do.

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
   - `PRETIX_TOOL_GROUPS` — (optional) comma-separated groups to enable,
     e.g. `orders,checkin,core`. Defaults to `orders,checkin` if unset.
     There is no default event slug — every tool takes `event` as an
     explicit parameter, since managing multiple events concurrently was
     a stated requirement.

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
      "args": ["/absolute/path/to/pretix-unraid/mcp/dist/index.js"],
      "env": {
        "PRETIX_BASE_URL": "https://your-pretix-instance.example",
        "PRETIX_API_TOKEN": "...",
        "PRETIX_ORGANIZER": "your-organizer-slug",
        "PRETIX_TOOL_GROUPS": "orders,checkin,core,sales,crm,admin"
      }
    }
  }
}
```

## HTTP transport (in progress, not recommended yet)

`src/http.ts` runs the same tools over HTTP (`StreamableHTTPServerTransport`)
instead of stdio — the intended path for eventually packaging this
alongside the pretix container itself. It currently has a known,
unresolved bug (malformed chunked-transfer-encoding response on the
`/mcp` endpoint) — use the stdio entrypoint (`dist/index.js`) for now.

## Testing against a local instance

This repo has a throwaway pretix test instance (SQLite-backed,
disposable) plus repo-local skills for resetting and seeding it with
test data — see `../.claude/skills/` and `../AGENTS.md`. Point
`PRETIX_BASE_URL` at that instance to develop against real data without
touching a production pretix. All 49 tools have been driven over real
MCP stdio JSON-RPC against that instance, including real (non-dry-run)
mutations — see `../plans/mcp-server.md` for what's been verified vs.
what still needs testing (multi-position orders, the `crm` group's
field names, secret-only ticket lookup).

## What this deliberately doesn't do

See `../plans/mcp-server.md`'s "Explicitly out of scope" section for
the full reasoning: no GDPR data shredders, no API token minting, no
event create/clone/delete, no seating-plan editing, no pretix Hosted
billing internals, no organizer-level plugin management.
