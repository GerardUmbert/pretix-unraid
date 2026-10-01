# AGENTS.md

Guidance for AI coding agents working in this repo.

## What this repo is

Two things, deliberately kept in one repo:

1. An Unraid Docker template + config for running
   [pretix](https://pretix.eu/) (event ticketing software) as a
   **throwaway local test instance**. There is no official Unraid
   Community Applications template for pretix, so this repo provides a
   manually installed one.
2. `mcp/` — an MCP server (`pretix-mcp`) that talks to a pretix
   instance's REST API, scoped to ticket status/history lookup and
   invalidate-and-reissue. It was originally its own repo and was merged
   in (with history, via `git subtree`) once the user decided they
   wanted "the MCP inside the Unraid thing with everything" rather than
   two separate repos.

**Important distinction**: the MCP server is *shipped inside* the custom
pretix image (the user explicitly asked for this, and for it to be
reachable by URL like their Subtitlarr MCP, not over SSH). A Node build
stage in the `Dockerfile` compiles `mcp/` into `/opt/pretix-mcp`. Its HTTP
transport (`mcp/src/http.ts`) runs under supervisord on 127.0.0.1:3000
and nginx exposes it at `/mcp` on the same address/port as the pretix UI
(`nginx-mcp-location.conf`, `supervisord-mcp.conf`, `pretix-mcp-http.sh`).
It only starts when `PRETIX_MCP_TOKEN` (bearer secret, >= 24 chars),
`PRETIX_API_TOKEN` and `PRETIX_ORGANIZER` are all set in the container
(Unraid template fields; the secret and token are masked and live only
in the NAS's container settings). Every request to `/mcp` needs
`Authorization: Bearer <PRETIX_MCP_TOKEN>`; it is exposed by the Funnel
if the Funnel is on, so that secret is the only protection then — keep it
long and out of chats/repos. The stdio entry point still works via
`docker exec -i pretix node /opt/pretix-mcp/dist/index.js`.

The same node process also serves a small test-lab page at `/lab`
(`mcp/src/lab.ts`, `lab-page.ts`; nginx `location /lab`): buttons to
create a demo event, fill random orders, simulate transfers, check-ins
and cancellations, and clear test data. The page is static; `/lab/api/*`
needs the same bearer secret. "Clear" only deletes events that are in test
mode and not live (plus their orders and `TEST` seating plans) and needs
the word CLEAR; there is deliberately no full wipe, so users, teams,
tokens and the organizer are never touched. Orders created by the MCP or
the lab in a test-mode event are flagged as test orders, which is what
lets pretix delete them.

Intended use: the MCP is a backoffice helper (trace ticket flow/history,
fast setup); a separate custom app is expected to call pretix's API
directly for orders, tickets/QRs and transfers. **Customer accounts are
not needed** for that flow (orders carry buyer email and per-ticket
attendee details; transfers use `pretix_transfer_ticket`). Change
webhooks must come from pretix itself, never from the MCP, since other
clients make changes too; pretix blocks webhook targets on
private/CGNAT/Tailscale addresses. Details in `USE_CASES.md`.

Gotchas: pretix rejects requests whose Host header is not its configured
URL, and Node's `fetch` silently ignores a custom `Host` header. So
inside the container the MCP calls `http://127.0.0.1:8345` with
`node:http` and sets `Host` to the host of `PRETIX_PRETIX_URL` (see
`mcp/src/client.ts`); set `PRETIX_BASE_URL` to bypass this and use a
plain URL (e.g. for local development: `npm run build` +
`node mcp/dist/index.js` against a local throwaway instance).

The pretix template/container side is explicitly NOT a production
setup:
- Uses a Postgres 17 that runs *inside* the same container (unix socket
  only, data in `/data/postgres`, started by
  `docker-entrypoint-plugins.sh`), not a separate DB service. It replaced
  SQLite because several workers writing at once hit `database is locked`.
  On first start with an existing `/data/db.sqlite3`, the entrypoint copies
  its data into Postgres (`pretix-db-copy.py`) and renames the file to
  `db.sqlite3.migrated`; `PRETIX_INTERNAL_POSTGRES=false` falls back to
  SQLite.
- A Redis runs *inside* the same container too (unix socket
  `/run/pretix-redis/redis.sock`, no persistence), started by
  `docker-entrypoint-plugins.sh` like Postgres. It is cache, session store
  and Celery broker. The user asked for this (to stress-test imports of
  ~30k tickets on the NAS; a UI import otherwise runs inside the web
  request). A Celery task worker (`pretix-task.sh`, concurrency
  `PRETIX_CELERY_CONCURRENCY`, default 4) and the periodic-job runner
  (`pretix-cron.sh`, every 15 min, so order expiry works) run under
  supervisord (`supervisord-tasks.conf`). `PRETIX_INTERNAL_REDIS=false`
  restores the old behaviour: no Redis, no worker, tasks run inline. The
  entrypoint exports the `PRETIX_REDIS_*`/`PRETIX_CELERY_*` env vars, so
  processes started with `docker exec` (e.g. `pretix shell`, the stdio MCP)
  do not have them and run tasks inline unless you pass them yourself.
  Postgres memory is tunable via `PRETIX_PG_*` template variables.
- No backup/upgrade story. To "reset," delete the appdata folder (or
  use the `pretix-reset` skill).

Do not "improve" this toward a production-grade setup (adding Redis, an
external Postgres, HTTPS termination, etc.) unless explicitly asked — that would
contradict the repo's actual purpose. If real production use is wanted,
point to pretix's own docker-compose stack in the
[self-hosting docs](https://docs.pretix.eu/self-hosting/) instead of
extending this repo.

## Files

- `Dockerfile` — builds a custom image on top of the official
  `pretix/standalone:stable`, adding `docker-entrypoint-plugins.sh`.
- `docker-entrypoint-plugins.sh` — runs as root, optionally pip-installs
  packages from `PRETIX_PLUGINS` (comma-separated), then drops privileges
  to `pretixuser` via `setpriv` before handing off to the real `pretix`
  entrypoint. See "Plugin install entrypoint" below before touching this.
- `.github/workflows/build-image.yml` — builds and pushes the image to
  GHCR on push to `master`. Unraid can't `docker build` itself, so a
  registry push is required for the Unraid template to consume the image.
- `my-pretix-standalone.xml` — Unraid Docker template (Unraid's XML schema
  for the "Add Container" UI, consumed by Unraid's dockerMan plugin). Its
  `<Repository>`/`<Registry>`/`<TemplateURL>` point at the user's GitHub
  (`GerardUmbert`) GHCR package and raw XML. It has `PUID`/`PGID`
  (default 99/100, Unraid's nobody:users) handled by
  `docker-entrypoint-plugins.sh`, which remaps `pretixuser` and chowns
  `/data` — same pattern as the user's Subtitlarr template.
- `pretix.cfg` — pretix's own config file format (`configparser`/INI).
  No longer mounted by the Unraid template: the image sets
  `PRETIX_PRETIX_DATADIR`/`PRETIX_PRETIX_INSTANCE_NAME` via `ENV` and the
  `PRETIX_DATABASE_*` variables for the internal Postgres, and the host-specific
  `PRETIX_PRETIX_URL` is a template variable. Pretix reads any config
  option from a `PRETIX_<SECTION>_<KEY>` env var, which takes precedence
  over the file (verified in `pretix/helpers/config.py`). The file is
  still mounted by `scripts/pretix-api/reset.sh` for local dev.
- `README.md` — human-facing install/run/build instructions for the
  pretix container/Unraid template side.
- `USE_CASES.md` — the actual day-to-day flows `mcp/` supports, and how
  to develop/test against this repo's local instance. Read this before
  `plans/` for "what is this for," and `plans/` for "why is it built
  this way."
- `plans/` — design docs for future work. `plans/mcp-server.md` also
  contains the empirically-verified facts about pretix's API behavior
  (ticket revocation, order history reconstruction) that `mcp/` and this
  repo's test scripts depend on — treat it as living documentation of
  *why*, not just a historical planning artifact, even after the code it
  describes exists. It still refers to "pretix-mcp" as a separate repo
  in places since it was written before the merge — that's a historical
  artifact of the doc, not a sign the merge didn't happen.
- `mcp/` — the actual MCP server source (TypeScript, `@modelcontextprotocol/sdk`).
  Merged in via `git subtree` from a formerly-separate `pretix-mcp` repo
  — its own commit history is preserved (`git log --follow` inside
  `mcp/` will show pre-merge commits). Has its own `package.json`/
  `tsconfig.json`/`.gitignore` (`node_modules/`, `dist/`) — it's a
  Node project; the root `Dockerfile` builds it in a `mcp-build` stage
  and copies the result into the image (`.github/workflows/build-image.yml`
  rebuilds the image on `mcp/**` changes). See `mcp/README.md` for its
  own setup instructions.
- `scripts/pretix-api/` — Node scripts (`seed.mjs`, `test.mjs`) and a
  bash script (`reset.sh`) for resetting/seeding/testing the local
  pretix instance. These call pretix's real REST API directly (plus
  `docker exec ... python3 -m pretix shell` for the one-time superuser/
  token bootstrap that has no API equivalent) — they are not mocked and
  are meant to be run against a real disposable container.
- `.claude/skills/pretix-reset/`, `.claude/skills/pretix-seed/`,
  `.claude/skills/pretix-test/` — Claude Code skills wrapping the
  scripts above, so an AI assistant working in this repo can reset/seed/
  test the instance without re-deriving the right commands each time.

## Base image

Built on top of the official `pretix/standalone:stable` image from
Docker Hub via a custom `Dockerfile`. The base image itself is never
modified beyond adding the plugin-install entrypoint — don't add
unrelated Dockerfile steps (extra services, config baked into the image,
etc.) without discussing scope first, since this is still meant to stay
a thin wrapper, not grow into a general-purpose custom pretix image.

Facts about the base image (verified by running it, not assumed):
- Base OS: Debian 13 (trixie).
- Entrypoint: `/usr/local/bin/pretix` (a bash wrapper), invoked as
  `pretix web` to run migrations then start nginx + gunicorn via
  supervisord. Runs as `pretixuser`. We use `web`, not `all`, and add our
  own supervisord programs for the task worker and cron (see the Redis
  note above): `all`'s stock worker has no broker unless Redis is set up
  and would retry RabbitMQ on 127.0.0.1:5672 forever. Neither stock mode
  runs the periodic-task cron (`pretix cron`); `pretix-cron.sh` does.
- Config file search order: `/etc/pretix/pretix.cfg`,
  `~/.pretix.cfg`, `./pretix.cfg` (see `pretix/settings.py`).
- Upstream nginx listens on port 80; our Dockerfile rewrites it to 8345 so the container port matches the template's host port (Unraid's Tailscale Serve/Funnel hook proxies to the host-mapped port number from inside the container, so 8345->80 broke Funnel).

## Config file (`pretix.cfg`) notes

- `[database]` mirrors the image's env defaults (internal Postgres over a
  unix socket); the env vars win anyway.
- No `[redis]` / `[celery]` section in the file — the internal Redis is
  configured through env vars exported by the entrypoint instead (see
  above). Do not add those sections to the file.
- Never fill this file with real secrets/production URLs and commit
  them — it's meant to be a generic test config. If a user wants a
  production-like config, that belongs in their own untracked copy, not
  in this repo's tracked `pretix.cfg`.

## Plugin install entrypoint

`docker-entrypoint-plugins.sh` must run as root (see Dockerfile — no
`USER pretixuser` line) because pip-installing into
`/usr/local/lib/python3.13/site-packages` requires root; `pretixuser`
only has passwordless sudo scoped to `/usr/bin/supervisord`, nothing
else (verified via `/etc/sudoers.d`), so sudo can't be used for the pip
step. Privilege drop to `pretixuser` uses `setpriv` (already present in
the base image, no extra package needed) before running any pretix
command.

Ordering matters and was wrong once already: `updateassets` reads
settings from the DB, so it fails on a fresh volume with "no such table"
if run before any migration has created the schema. The fix is to run
`pretix migrate` once in the entrypoint (before `updateassets`) even
though the real `pretix` binary migrates again on its own right after —
Django migrations are idempotent, so the double-run is harmless and
necessary for correct first-boot ordering. Do not remove the entrypoint's
own migrate call as "redundant" without re-testing a fresh volume.

## pretix internals worth knowing (hit while writing scripts/pretix-api/)

- `User` model has no `is_superuser` field — only `is_staff`. Don't
  guess Django-convention field names against pretix's models; check
  `Model._meta.get_fields()` in a shell first (this was gotten wrong
  once already).
- `Team` permissions are two booleans, `all_event_permissions` and
  `all_organizer_permissions`, not a set of granular `can_*` booleans
  (some older blog posts / stale docs reference `can_*` fields — those
  are wrong for the pretix version this repo pins, confirmed by
  inspecting the real model and hitting a Django `FieldError` when
  guessing `can_*` names).
- `createsuperuser --noinput` does not set a usable password — for a
  scripted/non-interactive setup, create the user via
  `python3 -m pretix shell` and call `.set_password()` directly (see
  `scripts/pretix-api/seed.mjs`).
- An event **cannot** be created with `"live": true` — pretix rejects
  it with a 400 until the event has quotas and payment configured.
  Create with `"live": false` (the default state right after creating
  it in the admin UI too).

## Networking / ports

- Only the web UI port (mapped host-side via the Unraid template,
  default `8345`) is ever exposed to the host.
- The bundled Postgres listens on a unix socket only (no TCP port), so
  nothing database-related is exposed or published, and it cannot collide
  with any other database on the NAS. Do not add port mappings for
  database/cache ports, and do not point this setup at other databases.

## Verifying changes

If you change `my-pretix-standalone.xml` or `pretix.cfg` in a way that
affects runtime behavior, verify it actually boots rather than assuming:

```sh
docker build -t pretix-custom:local .
docker run -d --name pretix-test \
  -v pretix_test_data:/data \
  -e PRETIX_PRETIX_URL=http://localhost:18345 \
  -p 18345:8345 \
  pretix-custom:local

# poll until it responds, e.g.:
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:18345/control/login/

docker rm -f pretix-test
docker volume rm pretix_test_data
```

A healthy instance returns HTTP 302 (redirect to login) on
`/control/login/` once migrations finish (~30-60s after start).

If the change touches `docker-entrypoint-plugins.sh` or `PRETIX_PLUGINS`
behavior specifically, always test with an actual plugin package (e.g.
`-e PRETIX_PLUGINS=pretix-passbook`, a real published package — confirmed
on PyPI) against a **fresh** volume, not a reused one — the migrate/
updateassets ordering bug above only reproduces on a fresh volume.

All of the above runs inside Docker only (images/containers in Docker
Desktop's or the NAS's Docker daemon) — never installs anything on the
host running the agent. Be explicit about this distinction if the user
asks, since "installing a plugin" sounds host-level but isn't.

## Commit conventions

No test suite here — it's Unraid XML + a Dockerfile + entrypoint script +
an INI config + docs + a GitHub Actions workflow. Keep commits scoped to
what actually changed; don't bundle unrelated doc rewrites with config
or Dockerfile changes.
