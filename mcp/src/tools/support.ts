import { z } from "zod";
import type { PretixClient } from "../client.js";
import type { PretixOrder, PretixOrderPosition } from "../types.js";
import { ORDER_STATUS_LABELS } from "../types.js";
import { buildPositionHistory, runPretixShell, type LogRow } from "./history.js";

// Backoffice / customer-support tools built around tickets (order positions).
// Anything that reads pretix's order log goes through `pretix shell` (see
// history.ts) and so only works where pretix is installed.

const MAX_PAGES = 200;
const MAX_BULK = 100;

const organizerField = z.string().optional().describe("Organizer slug. Defaults to PRETIX_ORGANIZER.");
const eventField = z.string().optional().describe("Event slug. Defaults to PRETIX_EVENT.");
const orderCodeField = z.string().describe("The pretix order code, e.g. 'ABC12'.");
const positionidField = z
  .number()
  .int()
  .optional()
  .describe(
    "Which ticket within the order (the order's positionid, 1-based, not the internal id). Required if the order has more than one active ticket.",
  );

interface Page<T> {
  count?: number;
  next: string | null;
  results: T[];
}

async function getAll<T>(client: PretixClient, path: string): Promise<{ rows: T[]; complete: boolean }> {
  const rows: T[] = [];
  const sep = path.includes("?") ? "&" : "?";
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await client.get<Page<T>>(`${path}${sep}page=${page}`);
    rows.push(...res.results);
    if (!res.next) return { rows, complete: true };
  }
  return { rows, complete: false };
}

function pickPosition(order: PretixOrder, positionid: number | undefined, verb: string): PretixOrderPosition {
  const active = order.positions.filter((p) => !p.canceled);
  if (positionid !== undefined) {
    const match = active.find((p) => p.positionid === positionid);
    if (!match) {
      throw new Error(
        `Order ${order.code} has no active ticket with positionid ${positionid}. Active tickets: ${active.map((p) => p.positionid).join(", ") || "none"}`,
      );
    }
    return match;
  }
  if (active.length !== 1) {
    throw new Error(
      `Order ${order.code} has ${active.length} active tickets (${active.map((p) => p.positionid).join(", ")}) — pass positionid to say which one to ${verb}.`,
    );
  }
  return active[0];
}

const isCheckedIn = (p: PretixOrderPosition) =>
  p.checkins.length > 0 && p.checkins[p.checkins.length - 1].type === "entry";

function ticketRow(order: { code: string; status: keyof typeof ORDER_STATUS_LABELS; email: string | null }, p: PretixOrderPosition) {
  return {
    order_code: order.code,
    order_status: ORDER_STATUS_LABELS[order.status],
    buyer_email: order.email,
    positionid: p.positionid,
    position_id: p.id,
    item: p.item,
    variation: p.variation,
    attendee_name: p.attendee_name,
    attendee_email: p.attendee_email ?? null,
    canceled: p.canceled,
    blocked: p.blocked ?? [],
    checked_in: isCheckedIn(p),
    checkin_count: p.checkins.length,
  };
}

function ticketPreview(order: PretixOrder, p: PretixOrderPosition) {
  return {
    order_code: order.code,
    positionid: p.positionid,
    position_id: p.id,
    attendee_name: p.attendee_name,
    attendee_email: p.attendee_email ?? null,
    buyer_email: order.email,
    checked_in: isCheckedIn(p),
    blocked: p.blocked ?? [],
  };
}

async function loadOrder(client: PretixClient, organizer: string, event: string, code: string) {
  return client.get<PretixOrder>(`/organizers/${organizer}/events/${event}/orders/${code}/`);
}

// ---------------------------------------------------------------- find ticket

export const findTicketInputSchema = {
  query: z
    .string()
    .min(2)
    .describe(
      "Anything the customer gives you: buyer or attendee email, attendee name, order code (or its start), or the ticket's current QR secret (or its start). Also matches a FORMER holder's name/email (any holder after the first change) and the buyer's email as it was before a change, via the order log. The name written at purchase is not kept by pretix once replaced, so the very first holder can only be found through the buyer's email.",
    ),
  event: z.string().optional().describe("Event slug to search. Omit to search every event of the organizer."),
  include_canceled: z.boolean().optional().describe("Also return canceled tickets. Default false."),
  organizer: organizerField,
};

const FORMER_SCRIPT = `
import json
from django_scopes import scopes_disabled
from pretix.base.models import Order, LogEntry
from django.contrib.contenttypes.models import ContentType

q = PH_QUERY.lower()
with scopes_disabled():
    ct = ContentType.objects.get_for_model(Order)
    qs = LogEntry.objects.filter(
        content_type=ct,
        event__organizer__slug=PH_ORG,
        action_type__in=["pretix.event.order.modified", "pretix.event.order.contact.changed"],
        data__icontains=PH_QUERY,
    ).select_related("event")
    if PH_EVENT:
        qs = qs.filter(event__slug=PH_EVENT)
    rows = list(qs)
    codes = {o.pk: o.code for o in Order.objects.filter(pk__in={r.object_id for r in rows})}
    out = []
    for r in rows:
        d = r.parsed_data
        positions = []
        if r.action_type == "pretix.event.order.modified":
            for item in d.get("data", []):
                text = (str(item.get("attendee_name", "")) + " " + str(item.get("attendee_email", ""))).lower()
                if q in text:
                    positions.append(item.get("position"))
            kind = "was attendee on this ticket"
        else:
            text = (str(d.get("old_email", "")) + " " + str(d.get("new_email", ""))).lower()
            if q not in text:
                continue
            kind = "was order email" if q in str(d.get("old_email", "")).lower() else "is order email"
        out.append({"event": r.event.slug, "order_code": codes.get(r.object_id), "positions": positions, "kind": kind, "datetime": r.datetime.isoformat()})
    print("PH_RESULT " + json.dumps(out, default=str))
`;

async function findFormerMatches(organizer: string, event: string | undefined, query: string) {
  const stdout = await runPretixShell(
    `PH_QUERY = ${JSON.stringify(query)}\nPH_ORG = ${JSON.stringify(organizer)}\nPH_EVENT = ${JSON.stringify(event ?? "")}\n${FORMER_SCRIPT}`,
  );
  const line = stdout.split("\n").find((l) => l.startsWith("PH_RESULT "));
  if (!line) throw new Error(`Log search produced no result. Output: ${stdout.trim().slice(-300)}`);
  return JSON.parse(line.slice("PH_RESULT ".length)) as Array<{
    event: string;
    order_code: string | null;
    positions: number[];
    kind: string;
    datetime: string;
  }>;
}

export async function findTicket(
  client: PretixClient,
  input: { query: string; event?: string; include_canceled?: boolean; organizer?: string },
) {
  const organizer = client.organizer(input.organizer);
  const q = encodeURIComponent(input.query);

  const eventSlugs = input.event
    ? [input.event]
    : (await getAll<{ slug: string }>(client, `/organizers/${organizer}/events/`)).rows.map((e) => e.slug);

  const found = new Map<string, ReturnType<typeof ticketRow> & { event: string; matched: string[] }>();
  const orderCache = new Map<string, PretixOrder>();

  for (const slug of eventSlugs) {
    const { rows } = await getAll<PretixOrderPosition & { order: string }>(
      client,
      `/organizers/${organizer}/events/${slug}/orderpositions/?search=${q}${input.include_canceled ? "&include_canceled_positions=true" : ""}`,
    );
    for (const p of rows) {
      const key = `${slug}/${p.order}/${p.positionid}`;
      let order = orderCache.get(`${slug}/${p.order}`);
      if (!order) {
        order = await loadOrder(client, organizer, slug, p.order);
        orderCache.set(`${slug}/${p.order}`, order);
      }
      const full = order.positions.find((x) => x.id === p.id) ?? p;
      found.set(key, { event: slug, ...ticketRow(order, full), matched: ["current data (holder, buyer, order code or QR)"] });
    }
  }

  let logNote: string | null = null;
  try {
    const former = await findFormerMatches(organizer, input.event, input.query);
    for (const f of former) {
      if (!f.order_code) continue;
      const orderKey = `${f.event}/${f.order_code}`;
      let order = orderCache.get(orderKey);
      if (!order) {
        order = await loadOrder(client, organizer, f.event, f.order_code);
        orderCache.set(orderKey, order);
      }
      const targets = f.positions.length > 0 ? order.positions.filter((p) => f.positions.includes(p.id)) : order.positions;
      for (const p of targets) {
        if (p.canceled && !input.include_canceled) continue;
        const key = `${f.event}/${f.order_code}/${p.positionid}`;
        const note = `${f.kind} (until ${f.datetime.slice(0, 19)}Z)`;
        const existing = found.get(key);
        if (existing) existing.matched.push(note);
        else found.set(key, { event: f.event, ...ticketRow(order, p), matched: [note] });
      }
    }
  } catch (err) {
    logNote = `Former holders were not searched: ${err instanceof Error ? err.message : String(err)}`;
  }

  const tickets = [...found.values()];
  return {
    query: input.query,
    events_searched: eventSlugs.length,
    count: tickets.length,
    ...(logNote ? { note: logNote } : {}),
    tickets,
  };
}

// ------------------------------------------------------------ list tickets

export const listTicketsInputSchema = {
  event: z.string().describe("Event slug."),
  status: z.enum(["n", "p", "e", "c"]).optional().describe("Only tickets whose order has this status: n=pending, p=paid, e=expired, c=canceled."),
  checked_in: z.boolean().optional().describe("true = only tickets that were scanned at least once, false = only never scanned."),
  item: z.number().int().optional().describe("Only this product (item id)."),
  search: z.string().optional().describe("Free-text: holder/buyer name or email, order code, QR start."),
  include_canceled: z.boolean().optional().describe("Include tickets canceled out of their order. Default false."),
  organizer: organizerField,
};

export async function listTickets(
  client: PretixClient,
  input: {
    event: string;
    status?: "n" | "p" | "e" | "c";
    checked_in?: boolean;
    item?: number;
    search?: string;
    include_canceled?: boolean;
    organizer?: string;
  },
) {
  const organizer = client.organizer(input.organizer);
  const params = new URLSearchParams();
  if (input.status) params.set("order__status", input.status);
  if (input.checked_in !== undefined) params.set("has_checkin", String(input.checked_in));
  if (input.item !== undefined) params.set("item", String(input.item));
  if (input.search) params.set("search", input.search);
  if (input.include_canceled) params.set("include_canceled_positions", "true");
  const query = params.toString();

  const { rows, complete } = await getAll<PretixOrderPosition & { order: string }>(
    client,
    `/organizers/${organizer}/events/${input.event}/orderpositions/${query ? `?${query}` : ""}`,
  );
  const orders = (await getAll<PretixOrder>(client, `/organizers/${organizer}/events/${input.event}/orders/`)).rows;
  const byCode = new Map(orders.map((o) => [o.code, o]));

  return {
    event: input.event,
    count: rows.length,
    scan_complete: complete,
    tickets: rows.map((p) => {
      const o = byCode.get(p.order);
      return o
        ? ticketRow(o, p)
        : { order_code: p.order, positionid: p.positionid, position_id: p.id, attendee_name: p.attendee_name, canceled: p.canceled };
    }),
  };
}

// ------------------------------------------------------------- cancel ticket

export const cancelTicketInputSchema = {
  order_code: orderCodeField,
  positionid: positionidField,
  organizer: organizerField,
  event: eventField,
  confirm: z
    .boolean()
    .describe(
      "Must be true to actually cancel the ticket. This removes only this ticket from the order, frees its quota/seat, and cannot be undone (re-add a ticket to the order instead). Call with confirm=false first to preview.",
    ),
};

export async function cancelTicket(
  client: PretixClient,
  input: { order_code: string; positionid?: number; organizer?: string; event?: string; confirm: boolean },
) {
  const organizer = client.organizer(input.organizer);
  const event = client.event(input.event);
  const order = await loadOrder(client, organizer, event, input.order_code);
  const target = pickPosition(order, input.positionid, "cancel");
  const active = order.positions.filter((p) => !p.canceled);

  const preview = ticketPreview(order, target);
  if (active.length === 1) {
    return {
      performed: false,
      message: `Ticket ${target.positionid} is the only active ticket in order ${order.code}. pretix does not allow removing the last ticket; use pretix_cancel_order to cancel the whole order instead.`,
      ticket: preview,
    };
  }
  if (!input.confirm) {
    return {
      performed: false,
      message: "Dry run — no change made. Re-call with confirm=true to cancel this one ticket.",
      would_cancel: preview,
      remaining_tickets_after: active.length - 1,
    };
  }
  await client.delete(`/organizers/${organizer}/events/${event}/orderpositions/${target.id}/`);
  return {
    performed: true,
    canceled: preview,
    remaining_active_tickets: active.length - 1,
    message: "Ticket canceled. Its QR no longer works. Any refund is separate (pretix_issue_refund).",
  };
}

// ------------------------------------------------------- block / unblock

export const blockTicketInputSchema = {
  order_code: orderCodeField,
  positionid: positionidField,
  reason: z
    .string()
    .regex(/^(admin|api:[a-zA-Z0-9._]+)$/)
    .optional()
    .describe("Block name: 'admin' or 'api:<label>' (letters, digits, dot, underscore). Default 'api:support'. Use the same name to unblock."),
  organizer: organizerField,
  event: eventField,
  confirm: z.boolean().describe("Must be true to apply. Call with confirm=false first to preview."),
};

async function setBlock(
  client: PretixClient,
  input: { order_code: string; positionid?: number; reason?: string; organizer?: string; event?: string; confirm: boolean },
  mode: "add" | "remove",
) {
  const organizer = client.organizer(input.organizer);
  const event = client.event(input.event);
  const name = input.reason ?? "api:support";
  const order = await loadOrder(client, organizer, event, input.order_code);
  const target = pickPosition(order, input.positionid, mode === "add" ? "block" : "unblock");
  const blocked = target.blocked ?? [];

  if (mode === "add" && blocked.includes(name)) {
    return { performed: false, message: `Ticket already has block '${name}'.`, ticket: ticketPreview(order, target) };
  }
  if (mode === "remove" && !blocked.includes(name)) {
    return {
      performed: false,
      message: `Ticket has no block named '${name}'. Current blocks: ${blocked.join(", ") || "none"}.`,
      ticket: ticketPreview(order, target),
    };
  }
  if (!input.confirm) {
    return {
      performed: false,
      message: `Dry run — no change made. Re-call with confirm=true to ${mode === "add" ? "block" : "unblock"} this ticket${
        mode === "add" ? " (its QR will be refused at check-in; nothing is canceled and it can be unblocked)" : ""
      }.`,
      ticket: ticketPreview(order, target),
      block_name: name,
    };
  }
  const updated = await client.post<PretixOrderPosition>(
    `/organizers/${organizer}/events/${event}/orderpositions/${target.id}/${mode === "add" ? "add_block" : "remove_block"}/`,
    { name },
  );
  return {
    performed: true,
    ticket: { ...ticketPreview(order, target), blocked: updated.blocked ?? [] },
    message: mode === "add" ? "Ticket blocked." : "Block removed.",
  };
}

export const blockTicket = (client: PretixClient, input: Parameters<typeof setBlock>[1]) => setBlock(client, input, "add");
export const unblockTicket = (client: PretixClient, input: Parameters<typeof setBlock>[1]) => setBlock(client, input, "remove");

// --------------------------------------------------------------- resend email

export const resendTicketEmailInputSchema = {
  order_code: orderCodeField,
  organizer: organizerField,
  event: eventField,
  confirm: z
    .boolean()
    .describe("Must be true to send. This emails the order's contact address a link to its tickets. Call with confirm=false first to see the recipient."),
};

export async function resendTicketEmail(
  client: PretixClient,
  input: { order_code: string; organizer?: string; event?: string; confirm: boolean },
) {
  const organizer = client.organizer(input.organizer);
  const event = client.event(input.event);
  const order = await loadOrder(client, organizer, event, input.order_code);
  if (!order.email) throw new Error(`Order ${order.code} has no email address.`);
  if (!input.confirm) {
    return {
      performed: false,
      message: "Dry run — nothing sent. Re-call with confirm=true to email the order link.",
      would_email: order.email,
      order_code: order.code,
      order_status: ORDER_STATUS_LABELS[order.status],
    };
  }
  await client.post(`/organizers/${organizer}/events/${event}/orders/${order.code}/resend_link/`);
  return { performed: true, emailed: order.email, order_code: order.code };
}

// ------------------------------------------------------------ update details

export const updateTicketDetailsInputSchema = {
  order_code: orderCodeField,
  positionid: positionidField,
  attendee_name: z.string().optional().describe("New attendee name."),
  attendee_email: z.string().optional().describe("New attendee email."),
  company: z.string().optional(),
  street: z.string().optional(),
  zipcode: z.string().optional(),
  city: z.string().optional(),
  organizer: organizerField,
  event: eventField,
  confirm: z
    .boolean()
    .describe(
      "Must be true to apply. This only edits details (e.g. fixing a typo); it does NOT change the QR. To hand the ticket to someone else use pretix_transfer_ticket. Call with confirm=false first to preview.",
    ),
};

export async function updateTicketDetails(
  client: PretixClient,
  input: {
    order_code: string;
    positionid?: number;
    attendee_name?: string;
    attendee_email?: string;
    company?: string;
    street?: string;
    zipcode?: string;
    city?: string;
    organizer?: string;
    event?: string;
    confirm: boolean;
  },
) {
  const organizer = client.organizer(input.organizer);
  const event = client.event(input.event);
  const order = await loadOrder(client, organizer, event, input.order_code);
  const target = pickPosition(order, input.positionid, "edit");

  const patch: Record<string, string> = {};
  for (const key of ["attendee_name", "attendee_email", "company", "street", "zipcode", "city"] as const) {
    if (input[key] !== undefined) patch[key] = input[key] as string;
  }
  if (Object.keys(patch).length === 0) throw new Error("Nothing to change: pass at least one field to update.");

  const before: Record<string, unknown> = {};
  for (const key of Object.keys(patch)) before[key] = (target as unknown as Record<string, unknown>)[key] ?? null;

  if (!input.confirm) {
    return {
      performed: false,
      message: "Dry run — no change made. Re-call with confirm=true to apply. The QR stays the same.",
      ticket: ticketPreview(order, target),
      from: before,
      to: patch,
    };
  }
  const updated = await client.patch<PretixOrderPosition>(
    `/organizers/${organizer}/events/${event}/orderpositions/${target.id}/`,
    patch,
  );
  return {
    performed: true,
    ticket: ticketPreview(order, updated),
    from: before,
    to: patch,
    qr_changed: updated.secret !== target.secret,
  };
}

// ------------------------------------------------------------ change product

export const changeTicketProductInputSchema = {
  order_code: orderCodeField,
  positionid: positionidField,
  item: z.number().int().describe("The new product (item id, from pretix_list_items)."),
  variation: z.number().int().optional().describe("New variation id, required if the product has variations."),
  price: z
    .string()
    .optional()
    .describe("New price for this ticket, e.g. '60.00'. Omit to let pretix recalculate from the new product's price."),
  organizer: organizerField,
  event: eventField,
  confirm: z
    .boolean()
    .describe(
      "Must be true to apply. Changes what this ticket is (upgrade/downgrade) and can change the order total; any money owed or refundable is handled separately. The QR is kept. Call with confirm=false first to preview.",
    ),
};

export async function changeTicketProduct(
  client: PretixClient,
  input: {
    order_code: string;
    positionid?: number;
    item: number;
    variation?: number;
    price?: string;
    organizer?: string;
    event?: string;
    confirm: boolean;
  },
) {
  const organizer = client.organizer(input.organizer);
  const event = client.event(input.event);
  const order = await loadOrder(client, organizer, event, input.order_code);
  const target = pickPosition(order, input.positionid, "change");

  const patch: Record<string, unknown> = { item: input.item };
  if (input.variation !== undefined) patch.variation = input.variation;
  if (input.price !== undefined) patch.price = input.price;

  const preview = {
    ticket: ticketPreview(order, target),
    from: { item: target.item, variation: target.variation, price: target.price },
    to: patch,
    order_total_before: order.total,
  };
  if (!input.confirm) {
    return { performed: false, message: "Dry run — no change made. Re-call with confirm=true to apply.", ...preview };
  }
  const updated = await client.patch<PretixOrderPosition>(
    `/organizers/${organizer}/events/${event}/orderpositions/${target.id}/`,
    patch,
  );
  const after = await loadOrder(client, organizer, event, order.code);
  return {
    performed: true,
    ticket: ticketPreview(after, updated),
    from: preview.from,
    to: { item: updated.item, variation: updated.variation, price: updated.price },
    order_total_before: order.total,
    order_total_after: after.total,
    qr_changed: updated.secret !== target.secret,
  };
}

// -------------------------------------------------------------- bulk actions

export const bulkTicketActionInputSchema = {
  action: z
    .enum(["reissue", "cancel", "block", "unblock"])
    .describe("reissue = new QR (old stops working), cancel = remove ticket from its order, block/unblock = refuse/allow the QR at check-in."),
  tickets: z
    .array(
      z.object({
        order_code: z.string().describe("Order code."),
        positionid: z.number().int().describe("Ticket number within the order (1-based)."),
      }),
    )
    .min(1)
    .max(MAX_BULK)
    .describe(`Up to ${MAX_BULK} tickets.`),
  reason: z
    .string()
    .regex(/^(admin|api:[a-zA-Z0-9._]+)$/)
    .optional()
    .describe("Block name for block/unblock. Default 'api:support'."),
  organizer: organizerField,
  event: eventField,
  confirm: z
    .boolean()
    .describe("Must be true to perform. confirm=false returns what each ticket would do and any that cannot be processed. Reissue and cancel are irreversible."),
};

export async function bulkTicketAction(
  client: PretixClient,
  input: {
    action: "reissue" | "cancel" | "block" | "unblock";
    tickets: Array<{ order_code: string; positionid: number }>;
    reason?: string;
    organizer?: string;
    event?: string;
    confirm: boolean;
  },
) {
  const organizer = client.organizer(input.organizer);
  const event = client.event(input.event);
  const base = `/organizers/${organizer}/events/${event}`;
  const name = input.reason ?? "api:support";
  const results: Array<Record<string, unknown>> = [];

  const orders = new Map<string, PretixOrder>();
  for (const t of input.tickets) {
    const label = { order_code: t.order_code, positionid: t.positionid };
    try {
      let order = orders.get(t.order_code);
      if (!order) {
        order = await loadOrder(client, organizer, event, t.order_code);
        orders.set(t.order_code, order);
      }
      const active = order.positions.filter((p) => !p.canceled);
      const target = active.find((p) => p.positionid === t.positionid);
      if (!target) throw new Error("no active ticket with that positionid");
      if (input.action === "cancel" && active.length <= 1) throw new Error("last ticket of the order; cancel the order instead");
      if (input.action === "block" && (target.blocked ?? []).includes(name)) throw new Error(`already blocked (${name})`);
      if (input.action === "unblock" && !(target.blocked ?? []).includes(name)) throw new Error(`not blocked with '${name}'`);

      if (!input.confirm) {
        results.push({ ...label, status: "would_" + input.action, attendee_name: target.attendee_name });
        continue;
      }
      if (input.action === "reissue") {
        const upd = await client.post<PretixOrderPosition>(`${base}/orderpositions/${target.id}/regenerate_secrets/`);
        target.secret = upd.secret;
      } else if (input.action === "cancel") {
        await client.delete(`${base}/orderpositions/${target.id}/`);
        target.canceled = true;
      } else {
        const upd = await client.post<PretixOrderPosition>(
          `${base}/orderpositions/${target.id}/${input.action === "block" ? "add_block" : "remove_block"}/`,
          { name },
        );
        target.blocked = upd.blocked ?? [];
      }
      results.push({ ...label, status: "done", attendee_name: target.attendee_name });
    } catch (err) {
      results.push({ ...label, status: "skipped", reason: err instanceof Error ? err.message : String(err) });
    }
  }

  const summary: Record<string, number> = {};
  for (const r of results) summary[String(r.status)] = (summary[String(r.status)] ?? 0) + 1;
  return {
    performed: input.confirm,
    action: input.action,
    message: input.confirm ? "Done. Review any skipped tickets below." : "Dry run — nothing changed. Re-call with confirm=true to perform.",
    summary,
    results,
  };
}

// ------------------------------------------------- transfers / reissue report

export const listTransfersInputSchema = {
  event: z.string().describe("Event slug."),
  organizer: organizerField,
};

const EVENT_LOG_SCRIPT = `
import json
from django_scopes import scopes_disabled
from pretix.base.models import Order, LogEntry
from django.contrib.contenttypes.models import ContentType

def actor(e):
    if e.api_token_id:
        return "api token: %s" % (e.api_token.name if e.api_token else e.api_token_id)
    if e.device_id:
        return "device: %s" % (e.device.name if e.device else e.device_id)
    if e.user_id:
        return "admin user #%s" % e.user_id
    return "system/customer"

with scopes_disabled():
    ct = ContentType.objects.get_for_model(Order)
    base = LogEntry.objects.filter(content_type=ct, event__slug=PH_EVENT, event__organizer__slug=PH_ORG)
    interesting = set(base.filter(action_type__in=[
        "pretix.event.order.modified", "pretix.event.order.changed.secret", "pretix.event.order.secret.changed",
    ]).values_list("object_id", flat=True))
    codes = {o.pk: o.code for o in Order.objects.filter(pk__in=interesting)}
    out = {}
    for e in base.filter(object_id__in=interesting).order_by("datetime", "pk").select_related("api_token", "device"):
        out.setdefault(codes[e.object_id], []).append({
            "datetime": e.datetime.isoformat(), "action_type": e.action_type, "actor": actor(e), "data": e.parsed_data,
        })
    print("PH_RESULT " + json.dumps(out, default=str))
`;

export async function listTransfers(client: PretixClient, input: { event: string; organizer?: string }) {
  const organizer = client.organizer(input.organizer);
  const stdout = await runPretixShell(
    `PH_EVENT = ${JSON.stringify(input.event)}\nPH_ORG = ${JSON.stringify(organizer)}\n${EVENT_LOG_SCRIPT}`,
  );
  const line = stdout.split("\n").find((l) => l.startsWith("PH_RESULT "));
  if (!line) throw new Error(`Order log script produced no result. Output: ${stdout.trim().slice(-300)}`);
  const byOrder = JSON.parse(line.slice("PH_RESULT ".length)) as Record<string, LogRow[]>;

  const { rows: orders } = await getAll<PretixOrder>(client, `/organizers/${organizer}/events/${input.event}/orders/`);
  const orderByCode = new Map(orders.map((o) => [o.code, o]));

  const tickets: Array<Record<string, unknown>> = [];
  let attendeeChanges = 0;
  let reissues = 0;
  for (const [code, rows] of Object.entries(byOrder)) {
    const order = orderByCode.get(code);
    if (!order) continue;
    const firstEmailChange = rows.find((r) => r.action_type === "pretix.event.order.contact.changed");
    const buyer = (firstEmailChange?.data?.old_email as string | undefined) ?? order.email;
    for (const p of order.positions) {
      const h = buildPositionHistory(p, rows, buyer);
      const changes = h.history.filter((e) => e.kind === "attendee_changed");
      const reissued = h.history.filter((e) => e.kind === "qr_reissued");
      if (changes.length === 0 && reissued.length === 0) continue;
      attendeeChanges += changes.length;
      reissues += reissued.length;
      tickets.push({
        order_code: code,
        positionid: p.positionid,
        position_id: p.id,
        buyer_email_at_purchase: buyer,
        current_holder: p.attendee_name,
        current_holder_email: p.attendee_email ?? null,
        canceled: p.canceled,
        attendee_changes: changes.length,
        qr_generation: h.qr_generation,
        timeline: [...changes, ...reissued]
          .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
          .map((e) => ({ at: e.timestamp, what: e.description, by: e.actor })),
      });
    }
  }

  return {
    event: input.event,
    tickets_with_attendee_change: tickets.filter((t) => (t.attendee_changes as number) > 0).length,
    tickets_with_qr_reissue: tickets.filter((t) => (t.qr_generation as number) > 1).length,
    total_attendee_changes: attendeeChanges,
    total_qr_reissues: reissues,
    note: "pretix logs every attendee edit the same way, so a typo fix looks like a transfer here. Orders whose log was deleted with the order are not included.",
    tickets,
  };
}

// ------------------------------------------------------------- denied scans

export const listDeniedScansInputSchema = {
  event: z.string().describe("Event slug."),
  order_code: z.string().optional().describe("Only scans of tickets in this order."),
  limit: z.number().int().min(1).max(500).optional().describe("Max rows, newest first. Default 100."),
  organizer: organizerField,
};

const DENIED_SCRIPT = `
import json
from django_scopes import scopes_disabled
from pretix.base.models import Order, LogEntry
from django.contrib.contenttypes.models import ContentType

with scopes_disabled():
    ct = ContentType.objects.get_for_model(Order)
    qs = LogEntry.objects.filter(content_type=ct, event__slug=PH_EVENT, event__organizer__slug=PH_ORG,
                                 action_type="pretix.event.checkin.denied")
    if PH_ORDER:
        qs = qs.filter(object_id__in=list(Order.objects.filter(code=PH_ORDER, event__slug=PH_EVENT).values_list("pk", flat=True)))
    qs = qs.order_by("-datetime", "-pk")[:PH_LIMIT]
    rows = list(qs)
    codes = {o.pk: o.code for o in Order.objects.filter(pk__in={r.object_id for r in rows})}
    out = []
    for r in rows:
        d = r.parsed_data
        out.append({
            "datetime": r.datetime.isoformat(), "order_code": codes.get(r.object_id), "positionid": d.get("positionid"),
            "position_id": d.get("position"), "reason": d.get("errorcode"), "list": d.get("list"),
            "type": d.get("type"), "forced": d.get("forced"),
        })
    print("PH_RESULT " + json.dumps(out, default=str))
`;

const DENIED_EXPLANATIONS: Record<string, string> = {
  already_redeemed: "ticket was already scanned in",
  invalid: "QR not recognised (wrong event, typo, or an old QR that was reissued)",
  unpaid: "order not paid",
  blocked: "ticket is blocked",
  invalid_time: "outside the ticket's valid time",
  canceled: "ticket/order canceled",
  product: "product not allowed on this check-in list",
  rules: "check-in rules refused it",
  revoked: "QR was revoked (reissued or canceled)",
  ambiguous: "QR matched more than one ticket",
};

export async function listDeniedScans(
  client: PretixClient,
  input: { event: string; order_code?: string; limit?: number; organizer?: string },
) {
  const organizer = client.organizer(input.organizer);
  const stdout = await runPretixShell(
    `PH_EVENT = ${JSON.stringify(input.event)}\nPH_ORG = ${JSON.stringify(organizer)}\nPH_ORDER = ${JSON.stringify(input.order_code ?? "")}\nPH_LIMIT = ${Number(input.limit ?? 100)}\n${DENIED_SCRIPT}`,
  );
  const line = stdout.split("\n").find((l) => l.startsWith("PH_RESULT "));
  if (!line) throw new Error(`Scan log script produced no result. Output: ${stdout.trim().slice(-300)}`);
  const rows = JSON.parse(line.slice("PH_RESULT ".length)) as Array<Record<string, any>>;
  return {
    event: input.event,
    count: rows.length,
    note: "Only scans that matched a ticket are logged. A scan of a completely unknown QR (for example an old reissued one) is not recorded by pretix.",
    scans: rows.map((r) => ({ ...r, meaning: DENIED_EXPLANATIONS[String(r.reason)] ?? undefined })),
  };
}
