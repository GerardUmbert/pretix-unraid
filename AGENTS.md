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

**Important distinction**: the MCP server does NOT run on the Unraid
NAS. It runs on whatever machine the AI client (e.g. Claude Code) runs
on, connecting to it via stdio — the NAS only ever runs the pretix
container itself, which `mcp/` then talks to over HTTP via its REST API
(pointed at the NAS's IP, or at a local throwaway instance during
development). Don't build Docker/Unraid packaging for `mcp/` itself
unless explicitly asked — that would be a real architecture change
(stdio → network transport), not a file move, and wasn't what was
requested.

The pretix template/container side is explicitly NOT a production
setup:
- Uses SQLite instead of Postgres.
- No Redis/Celery broker (pretix falls back to running tasks inline when
  `[celery]`/`[redis]` sections are absent from `pretix.cfg`).
- No backup/upgrade story. To "reset," delete the appdata folder (or
  use the `pretix-reset` skill).

Do not "improve" this toward a production-grade setup (adding Postgres,
Redis, HTTPS termination, etc.) unless explicitly asked — that would
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
- `pretix-standalone.xml` — Unraid Docker template (Unraid's XML schema
  for the "Add Container" UI, consumed by Unraid's dockerMan plugin). Its
  `<Repository>`/`<Registry>` fields have a `REPLACE_WITH_GITHUB_USERNAME`
  placeholder — that's intentional, not a bug, until the user fills in
  their actual GitHub username/registry path.
- `pretix.cfg` — pretix's own config file format (`configparser`/INI),
  mounted read-only into the container at `/etc/pretix/pretix.cfg`.
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
  Node project living inside this repo, not integrated into any
  Docker build here. See `mcp/README.md` for its own setup instructions.
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
  `pretix all` to run migrations then start web+worker+cron via
  supervisord. Runs as `pretixuser`.
- Config file search order: `/etc/pretix/pretix.cfg`,
  `~/.pretix.cfg`, `./pretix.cfg` (see `pretix/settings.py`).
- Exposes port 80 internally for the web UI.

## Config file (`pretix.cfg`) notes

- `[database] backend=sqlite3` — no external DB needed.
- No `[redis]` / `[celery]` section — this is intentional, not an
  oversight. Do not add one without also adding a Redis service, and do
  not add one at all unless the user asks for it, since it changes the
  scope of this repo (see above).
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
- No internal Postgres/Redis ports are published — there are no
  internal Postgres/Redis processes in this setup at all. Do not add
  port mappings for database/cache ports; the user has existing
  Postgres/Redis instances on their NAS and this setup must never
  collide with or reach toward those.

## Verifying changes

If you change `pretix-standalone.xml` or `pretix.cfg` in a way that
affects runtime behavior, verify it actually boots rather than assuming:

```sh
docker build -t pretix-custom:local .
docker run -d --name pretix-test \
  -v pretix_test_data:/data \
  -v "$(pwd)/pretix.cfg:/etc/pretix/pretix.cfg:ro" \
  -p 18345:80 \
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
