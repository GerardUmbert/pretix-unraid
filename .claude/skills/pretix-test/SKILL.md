---
name: pretix-test
description: Run integration tests against the seeded pretix test instance, verifying core assumptions (orders API shape, ticket regenerate_secrets revoking the old secret, etc). Use when the user wants to test, verify, or run a test suite/battery of tests against the pretix instance or its API assumptions.
---

# pretix-test

Runs real HTTP requests against a running, seeded pretix instance and
asserts on the responses — not mocked, not unit tests. This exists to
catch the case where a future pretix version changes API behavior that
`pretix-mcp`'s tools (especially `pretix_reissue_ticket`) depend on,
particularly the empirically-verified fact that
`orderpositions/{id}/regenerate_secrets/` causes the old secret to
immediately fail check-in with `reason: "invalid"`. If that ever stops
being true, this test suite is what would catch it.

## Run it

Requires a seeded instance — run `pretix-seed` first if you haven't,
and capture its printed `PRETIX_API_TOKEN`.

```sh
PRETIX_API_TOKEN=<token from seed output> node scripts/pretix-api/test.mjs
```

Environment variables:
- `PRETIX_API_TOKEN` (required)
- `PRETIX_BASE_URL` (default `http://localhost:8345`)
- `PRETIX_ORGANIZER` (default `testorg`)
- `PRETIX_EVENT` (default `testevent`)

Prints `PASS`/`FAIL` per assertion and a final count, exits non-zero if
anything failed. Note: this test run itself calls `regenerate_secrets`
on the first seeded order it finds as part of verifying revocation
behavior — that's a real, permanent change to that test order (old
secret becomes invalid). Fine for a throwaway instance; don't run this
against anything you care about keeping stable.

## When to use this

- User wants to "run tests," "verify the tool works," "check pretix
  still behaves the way the plan assumes," or similar.
- After a `pretix-seed` run, as a sanity check that seeding worked.
- Periodically, if the pretix image/version in use has been updated,
  to catch any API behavior change before it surfaces as a confusing
  bug in `pretix-mcp` itself.

## What this does NOT cover

This tests the pretix API's behavior, not `pretix-mcp`'s own code. To
test the actual MCP server end to end (driving it over real MCP stdio
JSON-RPC), see `pretix-mcp`'s own test setup once it has one — that's a
separate concern from verifying pretix's API assumptions here.
