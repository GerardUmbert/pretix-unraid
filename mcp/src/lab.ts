import type { PretixClient } from "./client.js";
import { PretixApiError } from "./client.js";
import { transferTicket } from "./tools/transfer.js";
import { checkinBySecret } from "./tools/checkin.js";
import { runPretixShell } from "./tools/history.js";
import type { PretixOrder } from "./types.js";

// Test-lab actions behind the /lab page (see http.ts). They only touch
// events and orders, and "clear" refuses anything that is not in test mode.
// Users, teams, tokens and the organizer are never modified.

const FIRST = ["Ana", "Luis", "Marta", "Jordi", "Carla", "Pau", "Elena", "Marc", "Sofia", "Iker", "Laia", "Hugo", "Nuria", "Oriol", "Irene", "Dani", "Julia", "Pol", "Clara", "Adria"];
const LAST = ["Ruiz", "Vidal", "Serra", "Puig", "Costa", "Ferrer", "Soler", "Roca", "Vila", "Mas", "Font", "Pons", "Marti", "Gil", "Bosch"];
const DIET_TEXT = ["", "", "", "No nuts", "Lactose intolerant", "Halal"];
const ACCESS_TEXT = ["", "", "", "", "Wheelchair access", "Needs seat near exit", "Hearing loop", "Step-free entrance"];

const pick = <T>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)];
const person = () => {
  const first = pick(FIRST);
  const last = pick(LAST);
  const n = Math.floor(Math.random() * 900) + 100;
  return { name: `${first} ${last}`, email: `${first}.${last}${n}@example.com`.toLowerCase() };
};

interface Item {
  id: number;
  name: Record<string, string>;
  default_price: string;
  active: boolean;
  has_variations: boolean;
  variations: Array<{ id: number; default_price: string | null; active: boolean }>;
}
interface Question {
  id: number;
  type: string;
  identifier: string;
  items: number[];
  options: Array<{ id: number; answer: Record<string, string> }>;
}
interface Seat {
  seat_guid: string;
  product: number | null;
  blocked: boolean;
  orderposition: number | null;
}

/** SQLite can answer 5xx ("database is locked") under load; 4xx are real errors and are not retried. */
async function retrying<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      const clientError = err instanceof PretixApiError && err.status >= 400 && err.status < 500;
      if (clientError || i >= attempts) throw err;
      await new Promise((r) => setTimeout(r, 1000 * i));
    }
  }
}

const base = (c: PretixClient, event: string) => `/organizers/${c.organizer()}/events/${event}`;

async function all<T>(c: PretixClient, path: string, cap = 30): Promise<T[]> {
  const out: T[] = [];
  const sep = path.includes("?") ? "&" : "?";
  for (let page = 1; page <= cap; page++) {
    const r = await c.get<{ next: string | null; results: T[] }>(`${path}${sep}page=${page}`);
    out.push(...r.results);
    if (!r.next) break;
  }
  return out;
}

export async function listEvents(c: PretixClient) {
  const events = await all<{ slug: string; name: Record<string, string>; testmode: boolean; live: boolean }>(
    c,
    `/organizers/${c.organizer()}/events/`,
  );
  return events.map((e) => ({ slug: e.slug, name: e.name.en ?? Object.values(e.name)[0], testmode: e.testmode, live: e.live }));
}

/** Creates a fully wired demo event: items, variations, quotas, questions, check-in list, seating. */
export async function createDemoEvent(c: PretixClient) {
  const stamp = Date.now().toString(36);
  const slug = `test-demo-${stamp}`;
  const org = c.organizer();
  const ev = base(c, slug);

  await c.post(`/organizers/${org}/events/`, {
    name: { en: `TEST Demo ${stamp}` },
    slug,
    date_from: new Date(Date.now() + 30 * 864e5).toISOString(),
    currency: "EUR",
    timezone: "Europe/Madrid",
    testmode: true,
    live: false,
    has_subevents: false,
  });
  const category = await c.post<{ id: number }>(`${ev}/categories/`, { name: { en: "TEST Tickets" } });
  const mk = (name: string, price: string, extra: object = {}) =>
    c.post<Item>(`${ev}/items/`, { name: { en: name }, default_price: price, tax_rate: "0.00", category: category.id, ...extra });

  const general = await mk("TEST General", "25.00");
  const vip = await mk("TEST VIP", "60.00");
  const table = await mk("TEST VIP Table", "90.00", {
    has_variations: true,
    variations: ["Table A", "Table B", "Table C"].map((v, i) => ({ value: { en: v }, default_price: null, active: true, position: i })),
  });
  const free = await mk("TEST Free guest", "0.00");

  await c.post(`${ev}/quotas/`, { name: "TEST General quota", size: 100, items: [general.id], variations: [] });
  await c.post(`${ev}/quotas/`, { name: "TEST VIP quota", size: 20, items: [vip.id], variations: [] });
  await c.post(`${ev}/quotas/`, { name: "TEST Table quota", size: 24, items: [table.id], variations: (table.variations ?? []).map((v) => v.id) });
  await c.post(`${ev}/quotas/`, { name: "TEST Guest quota", size: 30, items: [free.id], variations: [] });

  const allItems = [general.id, vip.id, table.id, free.id];
  await c.post(`${ev}/questions/`, {
    question: { en: "Dietary restrictions" },
    type: "M",
    required: false,
    items: allItems,
    identifier: "diet",
    show_during_checkin: true,
    options: ["Vegetarian", "Vegan", "Gluten-free", "Lactose-free"].map((a, i) => ({ answer: { en: a }, position: i, identifier: a.toUpperCase().replace(/[^A-Z]+/g, "-") })),
  });
  await c.post(`${ev}/questions/`, {
    question: { en: "Accessibility needs" },
    type: "T",
    required: false,
    items: allItems,
    identifier: "access",
    show_during_checkin: true,
  });
  await c.post(`${ev}/checkinlists/`, { name: "TEST Main entrance", all_products: true });

  const rows = ["A", "B", "C"].map((label) => ({
    row_number: label,
    position: { x: 0, y: (label.charCodeAt(0) - 65) * 50 },
    seats: Array.from({ length: 6 }, (_, i) => ({
      seat_number: String(i + 1),
      seat_guid: `${label}-${i + 1}`,
      position: { x: i * 30, y: 0 },
      category: "Standard",
    })),
  }));
  const plan = await c.post<{ id: number }>(`/organizers/${org}/seatingplans/`, {
    name: `TEST plan ${stamp}`,
    layout: {
      name: `TEST plan ${stamp}`,
      categories: [{ name: "Standard", color: "#4a90d9" }],
      zones: [{ name: "Main", position: { x: 0, y: 0 }, rows }],
      size: { width: 260, height: 190 },
    },
  });
  await c.patch(`${ev}/`, { seating_plan: plan.id, seat_category_mapping: { Standard: general.id } });

  return { event: slug, items: 4, seats: 18 };
}

export async function seedOrders(c: PretixClient, input: { event: string; count: number }) {
  const ev = base(c, input.event);
  const items = (await all<Item>(c, `${ev}/items/`)).filter((i) => i.active);
  if (items.length === 0) throw new Error("This event has no active items. Create the demo event first.");
  const questions = await all<Question>(c, `${ev}/questions/`);
  const seatsByProduct = new Map<number, string[]>();
  try {
    for (const s of await all<Seat>(c, `${ev}/seats/?is_available=true`)) {
      if (s.product && !s.blocked) seatsByProduct.set(s.product, [...(seatsByProduct.get(s.product) ?? []), s.seat_guid]);
    }
  } catch {
    // no seating plan on this event
  }

  const testmode = (await c.get<{ testmode: boolean }>(`${ev}/`)).testmode;
  const created: string[] = [];
  const failures: string[] = [];
  for (let n = 0; n < Math.min(input.count, 100); n++) {
    const buyer = person();
    const roll = Math.random();
    const status: "p" | "n" = roll < 0.65 ? "p" : "n";
    const cancelAfter = roll > 0.92;
    const positions = Array.from({ length: pick([1, 1, 1, 2, 2, 3, 4]) }, () => {
      // Seated products can only be sold while seats are left.
      const usable = items.filter((i) => !seatsByProduct.has(i.id) || (seatsByProduct.get(i.id)?.length ?? 0) > 0);
      const item = pick(usable.length ? usable : items);
      const variation = item.has_variations ? pick(item.variations.filter((v) => v.active)) : undefined;
      const price = variation?.default_price ?? item.default_price;
      const holder = Math.random() < 0.6 ? buyer : person();
      const answers: Array<{ question: number; answer: string; options?: number[] }> = [];
      for (const q of questions.filter((qq) => qq.items.includes(item.id))) {
        if (q.type === "M" || q.type === "C") {
          if (Math.random() < 0.4 && q.options.length) {
            const o = pick(q.options);
            answers.push({ question: q.id, answer: o.answer.en ?? Object.values(o.answer)[0], options: [o.id] });
          }
        } else if (q.type === "T" || q.type === "S") {
          const text = pick(q.identifier.includes("access") ? ACCESS_TEXT : DIET_TEXT);
          if (text) answers.push({ question: q.id, answer: text });
        }
      }
      const free = seatsByProduct.get(item.id);
      const seat = free?.length ? free.splice(Math.floor(Math.random() * free.length), 1)[0] : undefined;
      return {
        item: item.id,
        price,
        attendee_name: holder.name,
        attendee_email: holder.email,
        ...(variation ? { variation: variation.id } : {}),
        ...(answers.length ? { answers } : {}),
        ...(seat ? { seat } : {}),
      };
    });
    try {
      const order = await retrying(() => c.post<PretixOrder>(`${ev}/orders/`, {
        email: buyer.email,
        locale: "en",
        sales_channel: "web",
        fees: [],
        status,
        payment_provider: "manual",
        invoice_address: {},
        send_email: false,
        ...(testmode ? { testmode: true } : {}),
        positions,
      }));
      if (cancelAfter) await retrying(() => c.post(`${ev}/orders/${order.code}/mark_canceled/`, { send_email: false }));
      created.push(order.code);
    } catch (err) {
      failures.push(err instanceof PretixApiError ? JSON.stringify(err.body).slice(0, 160) : String(err));
    }
  }
  return { created: created.length, failed: failures.length, codes: created, failures: failures.slice(0, 3) };
}

async function orders(c: PretixClient, event: string, status?: string) {
  return all<PretixOrder>(c, `${base(c, event)}/orders/${status ? `?status=${status}` : ""}`);
}

export async function randomTransfer(
  c: PretixClient,
  input: { event: string; order_code?: string; positionid?: number; name?: string; email?: string; reissue?: boolean },
) {
  let order: PretixOrder | undefined;
  if (input.order_code) {
    order = await c.get<PretixOrder>(`${base(c, input.event)}/orders/${input.order_code}/`);
  } else {
    const candidates = (await orders(c, input.event)).filter((o) => o.status === "p" || o.status === "n");
    if (candidates.length === 0) throw new Error("No active orders to transfer from. Fill some data first.");
    order = pick(candidates);
  }
  const live = order.positions.filter((p) => !p.canceled);
  const position = input.positionid ? live.find((p) => p.positionid === input.positionid) : pick(live);
  if (!position) throw new Error("That position does not exist or is cancelled.");
  const next = input.name ? { name: input.name, email: input.email } : person();
  const before = position.secret;
  const result = await transferTicket(c, {
    order_code: order.code,
    positionid: position.positionid,
    new_attendee_name: next.name,
    new_attendee_email: next.email,
    update_order_email: false,
    reissue_secret: input.reissue ?? true,
    event: input.event,
    confirm: true,
  });
  return { order: order.code, positionid: position.positionid, from: position.attendee_name, to: next.name, old_secret_replaced: (input.reissue ?? true) && before !== undefined, result };
}

export async function randomCheckins(c: PretixClient, input: { event: string; count: number }) {
  const lists = await all<{ id: number }>(c, `${base(c, input.event)}/checkinlists/`);
  if (lists.length === 0) throw new Error("This event has no check-in list.");
  const paid = await orders(c, input.event, "p");
  const secrets = paid.flatMap((o) => o.positions.filter((p) => !p.canceled && p.checkins.length === 0).map((p) => ({ order: o.code, secret: p.secret })));
  const chosen = secrets.sort(() => Math.random() - 0.5).slice(0, input.count);
  const done: string[] = [];
  for (const s of chosen) {
    const r = await checkinBySecret(c, { list_ids: [lists[0].id], secret: s.secret, type: "entry" });
    if (r.success) done.push(s.order);
  }
  return { checked_in: done.length, orders: done };
}

export async function randomCancels(c: PretixClient, input: { event: string; count: number }) {
  const open = (await orders(c, input.event)).filter((o) => o.status === "n" || (o.status === "p" && o.positions.every((p) => p.checkins.length === 0)));
  const done: string[] = [];
  for (const o of open.sort(() => Math.random() - 0.5).slice(0, input.count)) {
    await c.post(`${base(c, input.event)}/orders/${o.code}/mark_canceled/`, { send_email: false });
    done.push(o.code);
  }
  return { cancelled: done.length, orders: done };
}

// Deletes test-mode orders with pretix's own bulk delete (the one behind
// "delete test orders" in the control panel) in small transactions. Doing it
// order by order over the REST API took minutes per thousand orders and only
// ever saw the first page of them. One run stops after ~35 s so the HTTP
// request does not time out; run Clear again to continue.
const DELETE_ORDERS_SCRIPT = `
import json, time
from django.db import transaction
from django_scopes import scopes_disabled
from pretix.base.models import Event, Order

with scopes_disabled():
    ev = Event.objects.get(organizer__slug=PH_ORG, slug=PH_EVENT)
    if not ev.testmode or ev.live:
        raise SystemExit("event is not in test mode or is live")
    started = time.time()
    deleted = 0
    while time.time() - started < 35:
        pks = list(Order.objects.filter(event=ev, testmode=True).values_list("pk", flat=True)[:200])
        if not pks:
            break
        with transaction.atomic():
            Order.gracefully_delete_bulk(ev, Order.objects.filter(pk__in=pks))
        deleted += len(pks)
    print("PH_RESULT " + json.dumps({"deleted": deleted, "remaining": Order.objects.filter(event=ev).count()}))
`;

async function deleteTestOrders(c: PretixClient, event: string): Promise<{ deleted: number; remaining: number }> {
  const stdout = await runPretixShell(
    `PH_ORG = ${JSON.stringify(c.organizer())}\nPH_EVENT = ${JSON.stringify(event)}\n${DELETE_ORDERS_SCRIPT}`,
  );
  const line = stdout.split("\n").find((l) => l.startsWith("PH_RESULT "));
  if (!line) throw new Error(`Order deletion produced no result. Output: ${stdout.trim().slice(-300)}`);
  return JSON.parse(line.slice("PH_RESULT ".length));
}

/** Deletes every event in test mode (and its orders). Live or non-test events are never touched. */
export async function clearTestData(c: PretixClient) {
  const org = c.organizer();
  const events = await listEvents(c);
  const deleted: string[] = [];
  const skipped: Array<{ event: string; reason: string }> = [];
  const unfinished: Array<{ event: string; orders_left: number }> = [];
  for (const e of events) {
    if (!e.testmode || e.live) {
      skipped.push({ event: e.slug, reason: e.live ? "live" : "not in test mode" });
      continue;
    }
    try {
      const { remaining } = await deleteTestOrders(c, e.slug);
      if (remaining > 0) {
        // out of time (or non-test orders present): the event stays until a later run empties it
        unfinished.push({ event: e.slug, orders_left: remaining });
        continue;
      }
      await c.delete(`${base(c, e.slug)}/`);
      deleted.push(e.slug);
    } catch (err) {
      skipped.push({ event: e.slug, reason: err instanceof PretixApiError ? `pretix ${err.status}: ${JSON.stringify(err.body).slice(0, 120)}` : String(err) });
    }
  }
  let plansDeleted = 0;
  try {
    for (const p of await all<{ id: number; name: string }>(c, `/organizers/${org}/seatingplans/`)) {
      if (!p.name.startsWith("TEST")) continue;
      try {
        await c.delete(`/organizers/${org}/seatingplans/${p.id}/`);
        plansDeleted++;
      } catch {
        // still in use by a kept event
      }
    }
  } catch {
    // seating plans unavailable
  }
  return { deleted_events: deleted, unfinished_run_clear_again: unfinished, skipped, seating_plans_deleted: plansDeleted };
}
