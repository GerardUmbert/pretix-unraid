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
| `core` | Events, items (with variations and metadata), categories, tax rules, quotas, custom questions (dietary/accessibility notes), seating plans and seats | Opt-in |
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
     e.g. `orders,checkin,core`. Defaults to all groups if unset.
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
touching a production pretix. All 49 original tools have been driven over real
MCP stdio JSON-RPC against that instance, including real (non-dry-run)
mutations — see `../plans/mcp-server.md` for what's been verified vs.
what still needs testing (multi-position orders, the `crm` group's
field names, secret-only ticket lookup).

## What this deliberately doesn't do

See `../plans/mcp-server.md`'s "Explicitly out of scope" section for
the full reasoning: no GDPR data shredders, no API token minting, no
event create/clone/delete, no seating-plan editing, no pretix Hosted
billing internals, no organizer-level plugin management.

## Bundled in the pretix container

The Unraid image built from this repo already contains a compiled copy of
this server, served at `/mcp` on the same address as pretix itself, so
nothing needs building or installing on your PC. In the container's
template settings set:

- `MCP Access Secret` (`PRETIX_MCP_TOKEN`): a long random secret (24+
  characters) that clients must send as a Bearer token.
- `MCP API Token` (`PRETIX_API_TOKEN`): a team API key from pretix (the
  key needs a name).
- `MCP Organizer` (`PRETIX_ORGANIZER`): the organizer's short form.

Then add it to Claude Code (keep `--scope user` so the secret does not
end up in a repo):

```sh
claude mcp add --transport http pretix --scope user https://<your-pretix-url>/mcp --header "Authorization: Bearer <secret>"
```

Without all three variables the endpoint is not started. If pretix is
exposed to the internet (e.g. a Tailscale Funnel), `/mcp` is too, and the
secret is the only protection.

## Test lab (`/lab`)

When the HTTP server runs inside the container, `https://<host>/lab` serves
a small page for throwaway test data: create a demo event, fill random
orders, simulate ticket transfers, check-ins and cancellations, and clear
test data. Enter `PRETIX_MCP_TOKEN` once on the page; every action goes
through `/lab/api/*` with that bearer secret. Clearing deletes only events
in test mode that are not live, together with their orders; it never
touches users, teams, tokens or the organizer.
