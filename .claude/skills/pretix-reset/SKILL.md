---
name: pretix-reset
description: Wipe the pretix test instance back to completely empty by destroying its container/volume and starting a fresh one. Use when the user wants to reset, clear, wipe, or start over with the pretix test instance in this repo (pretix-unraid).
---

# pretix-reset

Destroys the running pretix test container and its data volume, then
starts a fresh one from the same image. This is a full wipe, not a
selective reset — the instance is SQLite-backed and explicitly
throwaway (see this repo's `AGENTS.md`), so there's no notion of
resetting "just orders" or "just one event."

## Run it

```sh
bash scripts/pretix-api/reset.sh
```

Environment variables (all optional, defaults shown):
- `PRETIX_CONTAINER_NAME` (default `pretix`)
- `PRETIX_DATA_VOLUME` (default `pretix_data`)
- `PRETIX_IMAGE` (default `pretix-custom:local` — build it first with
  `docker build -t pretix-custom:local .` from the repo root if it
  doesn't exist yet)
- `PRETIX_CONFIG_FILE` (default: this repo's `pretix.cfg`)
- `PRETIX_PORT` (default `8345`)

The script waits for the fresh instance to finish migrating before
returning, so it's safe to immediately follow with the `pretix-seed`
skill afterward.

## When to use this

- User says "reset pretix", "clear the test instance", "start fresh",
  "wipe pretix", or similar.
- Before a `pretix-seed` run if the instance might have stale/dirty
  data from prior manual testing.
- As the first step when debugging something that might be caused by
  accumulated test-data cruft rather than an actual bug.

Don't run this against anything other than the local throwaway test
instance — there is no confirmation prompt, and it is genuinely
destructive by design.
