#!/usr/bin/env node
// Seeds a running pretix test instance with a superuser, API token,
// organizer, event, item, quota, and one paid+checked-in test order.
// Talks to the container via `docker exec` (for the one-time superuser/
// token creation, which needs Django shell access) and the REST API
// (for everything else, exactly the calls a real client would make).
//
// This mirrors the exact sequence empirically verified while designing
// pretix-mcp's reissue tool - see plans/mcp-server.md for that record.
// If pretix's API shape changes and this script breaks, that plan doc's
// "Verified facts" section is now stale too and should be re-checked.

import { execFileSync } from "node:child_process";

const CONTAINER = process.env.PRETIX_CONTAINER_NAME ?? "pretix";
const BASE_URL = process.env.PRETIX_BASE_URL ?? "http://localhost:8345";
const ORGANIZER_SLUG = process.env.PRETIX_SEED_ORGANIZER ?? "testorg";
const EVENT_SLUG = process.env.PRETIX_SEED_EVENT ?? "testevent";

function dockerExecShell(pythonCode) {
  return execFileSync(
    "docker",
    ["exec", CONTAINER, "python3", "-m", "pretix", "shell", "-c", pythonCode],
    { encoding: "utf8" },
  );
}

async function api(token, method, path, body) {
  const res = await fetch(`${BASE_URL}/api/v1${path}`, {
    method,
    headers: {
      Authorization: `Token ${token}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

function extractLastLine(output) {
  return output.trim().split("\n").pop();
}

async function main() {
  console.log(`[seed] Creating superuser in container "${CONTAINER}"...`);
  dockerExecShell(`
from pretix.base.models import User
u, created = User.objects.get_or_create(email='test@test.local', defaults={'is_staff': True})
u.is_staff = True
u.set_password('testpass12345')
u.save()
print('OK', u.email, created)
`);

  console.log(`[seed] Creating organizer "${ORGANIZER_SLUG}", team, and API token...`);
  const tokenOutput = dockerExecShell(`
from pretix.base.models import User, Organizer, Team, TeamAPIToken
u = User.objects.get(email='test@test.local')
org, _ = Organizer.objects.get_or_create(slug='${ORGANIZER_SLUG}', defaults={'name': 'Test Org'})
team, _ = Team.objects.get_or_create(organizer=org, name='API Team', defaults={
    'all_events': True, 'all_event_permissions': True, 'all_organizer_permissions': True,
})
team.members.add(u)
token, _ = TeamAPIToken.objects.get_or_create(team=team, name='seed-script-token')
print(token.token)
`);
  const token = extractLastLine(tokenOutput);
  console.log(`[seed] Token: ${token}`);

  console.log(`[seed] Creating event "${EVENT_SLUG}"...`);
  await api(token, "POST", `/organizers/${ORGANIZER_SLUG}/events/`, {
    name: { en: "Test Event" },
    slug: EVENT_SLUG,
    live: false,
    testmode: false,
    currency: "EUR",
    date_from: "2026-12-01T18:00:00Z",
    timezone: "UTC",
  }).catch((err) => {
    if (!String(err).includes("already exists") && !String(err).includes("400")) throw err;
    console.log("[seed] Event may already exist, continuing...");
  });

  console.log("[seed] Creating item...");
  const item = await api(token, "POST", `/organizers/${ORGANIZER_SLUG}/events/${EVENT_SLUG}/items/`, {
    name: { en: "Standard Ticket" },
    default_price: "10.00",
    tax_rate: "0.00",
  });

  console.log("[seed] Creating quota...");
  await api(token, "POST", `/organizers/${ORGANIZER_SLUG}/events/${EVENT_SLUG}/quotas/`, {
    name: "General",
    size: 100,
    items: [item.id],
  });

  console.log("[seed] Creating checkin list...");
  await api(token, "POST", `/organizers/${ORGANIZER_SLUG}/events/${EVENT_SLUG}/checkinlists/`, {
    name: "Main Entrance",
    all_products: true,
  });

  console.log("[seed] Creating paid test order...");
  const order = await api(token, "POST", `/organizers/${ORGANIZER_SLUG}/events/${EVENT_SLUG}/orders/`, {
    email: "customer@example.com",
    locale: "en",
    sales_channel: "web",
    fees: [],
    status: "p",
    payment_provider: "manual",
    invoice_address: {},
    positions: [
      { item: item.id, price: "10.00", attendee_name: "Jane Doe", secret: "TEST-SECRET-001" },
    ],
  });

  console.log(`[seed] Checking in order ${order.code}'s position...`);
  await api(token, "POST", `/organizers/${ORGANIZER_SLUG}/checkinrpc/redeem/`, {
    secret: "TEST-SECRET-001",
    lists: [1],
  });

  console.log("");
  console.log("=== SEED COMPLETE ===");
  console.log(`PRETIX_BASE_URL=${BASE_URL}`);
  console.log(`PRETIX_API_TOKEN=${token}`);
  console.log(`PRETIX_ORGANIZER=${ORGANIZER_SLUG}`);
  console.log(`PRETIX_EVENT=${EVENT_SLUG}`);
  console.log(`Test order code: ${order.code}`);
}

main().catch((err) => {
  console.error("[seed] FAILED:", err.message);
  process.exit(1);
});
