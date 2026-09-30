---
name: pretix-seed
description: Populate the pretix test instance with a superuser, API token, organizer, event, item, quota, and one paid+checked-in test order. Use when the user wants to seed, pre-load, populate, or add test/fake data to the pretix test instance, or needs an API token to test pretix-mcp or the REST API manually.
---

# pretix-seed

Creates everything needed to start testing against the pretix instance
from a completely empty state: a superuser (via Django shell, since
`createsuperuser --noinput` can't set a usable password), an organizer
+ team + full-permission API token (via Django shell, since there's no
UI-free way to mint the first token otherwise), then a test event, item,
quota, checkin list, and one paid order that's already been checked in
once — via the real REST API, the same calls a real client would make.

This is the reference implementation for the empirical sequence
documented in `plans/mcp-server.md`'s "Verified facts" section — if you
change this script, that plan doc's transcript may need updating too if
the API shape has changed.

## Run it

```sh
node scripts/pretix-api/seed.mjs
```

Environment variables (all optional, defaults shown):
- `PRETIX_CONTAINER_NAME` (default `pretix`) — must be a running
  container name/ID, used for `docker exec` to create the superuser/token
- `PRETIX_BASE_URL` (default `http://localhost:8345`)
- `PRETIX_SEED_ORGANIZER` (default `testorg`)
- `PRETIX_SEED_EVENT` (default `testevent`)

Prints the API token and test order code at the end — capture these,
they're needed to configure `pretix-mcp` or to run the `pretix-test`
skill against this instance.

Safe to run against an instance that already has this organizer/event —
`get_or_create` calls mean the superuser/org/team/token steps won't
duplicate, though re-running will create an *additional* test order
each time (harmless, just extra data) rather than reusing the old one.

## When to use this

- User wants to test `pretix-mcp` against real data and there's no data
  yet (fresh instance, or just ran `pretix-reset`).
- User asks to "add test data," "seed the tool," "create a test event,"
  or similar.
- Before running the `pretix-test` skill, which expects seeded data to
  already exist.
