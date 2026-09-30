#!/usr/bin/env node
// Integration tests against a running, seeded pretix test instance.
// Not unit tests - these hit the real REST API of whatever instance
// PRETIX_BASE_URL points at. Run scripts/pretix-api/seed.mjs first
// (or use the pretix-seed skill), then this script.
//
// Exit code 0 = all assertions passed, 1 = at least one failed. Prints
// a PASS/FAIL line per assertion rather than stopping at the first
// failure, so a broken run tells you everything that's wrong at once.

const BASE_URL = process.env.PRETIX_BASE_URL ?? "http://localhost:8345";
const TOKEN = process.env.PRETIX_API_TOKEN;
const ORGANIZER = process.env.PRETIX_ORGANIZER ?? "testorg";
const EVENT = process.env.PRETIX_EVENT ?? "testevent";

if (!TOKEN) {
  console.error("PRETIX_API_TOKEN is not set. Run the seed script first and export its output.");
  process.exit(1);
}

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`PASS: ${message}`);
    passed++;
  } else {
    console.log(`FAIL: ${message}`);
    failed++;
  }
}

async function api(method, path, body) {
  const res = await fetch(`${BASE_URL}/api/v1${path}`, {
    method,
    headers: {
      Authorization: `Token ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  return { status: res.status, data };
}

async function main() {
  console.log(`Testing against ${BASE_URL} (organizer=${ORGANIZER}, event=${EVENT})\n`);

  const eventsRes = await api("GET", `/organizers/${ORGANIZER}/events/`);
  assert(eventsRes.status === 200, "list events returns 200");
  assert(
    eventsRes.data?.results?.some((e) => e.slug === EVENT),
    `event "${EVENT}" exists in organizer "${ORGANIZER}"`,
  );

  const ordersRes = await api("GET", `/organizers/${ORGANIZER}/events/${EVENT}/orders/`);
  assert(ordersRes.status === 200, "list orders returns 200");
  assert(ordersRes.data?.results?.length > 0, "at least one seeded order exists");

  const testOrder = ordersRes.data?.results?.[0];
  if (!testOrder) {
    console.log("No orders found - skipping order-detail and reissue tests.");
  } else {
    const orderRes = await api(
      "GET",
      `/organizers/${ORGANIZER}/events/${EVENT}/orders/${testOrder.code}/`,
    );
    assert(orderRes.status === 200, `get order ${testOrder.code} returns 200`);
    assert(
      Array.isArray(orderRes.data?.payments) && Array.isArray(orderRes.data?.refunds),
      "order response includes payments[] and refunds[] arrays",
    );
    assert(
      orderRes.data?.positions?.[0]?.checkins !== undefined,
      "order position includes checkins[] array",
    );

    const position = orderRes.data?.positions?.[0];
    if (position) {
      const oldSecret = position.secret;
      const regenRes = await api(
        "POST",
        `/organizers/${ORGANIZER}/events/${EVENT}/orderpositions/${position.id}/regenerate_secrets/`,
      );
      assert(regenRes.status === 200, "regenerate_secrets returns 200");
      assert(
        regenRes.data?.secret && regenRes.data.secret !== oldSecret,
        "regenerate_secrets returns a different secret than before",
      );

      const oldSecretCheckin = await api(
        "POST",
        `/organizers/${ORGANIZER}/checkinrpc/redeem/`,
        { secret: oldSecret, lists: [1] },
      );
      assert(
        oldSecretCheckin.data?.status === "error" && oldSecretCheckin.data?.reason === "invalid",
        "old secret is rejected as invalid after regeneration",
      );
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Test run crashed:", err);
  process.exit(1);
});
