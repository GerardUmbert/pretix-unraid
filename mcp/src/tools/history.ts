import { execFile } from "node:child_process";
import { z } from "zod";
import type { PretixClient } from "../client.js";
import type { PretixOrder, PretixOrderPosition } from "../types.js";

// pretix's REST API does not expose the order log (the history tab in the
// admin UI), so this tool reads LogEntry rows through `pretix shell`. That
// only works where pretix itself is installed, i.e. inside the container
// (HTTP transport, or `docker exec -i pretix node ...` for stdio).
// PRETIX_SHELL_CMD overrides the command, e.g. "docker exec -i pretix python3 -m pretix shell".

export const ticketHistoryInputSchema = {
  order_code: z
    .string()
    .optional()
    .describe("The pretix order code, e.g. 'ABC12'. Required unless position_id or secret is given instead."),
  secret: z
    .string()
    .optional()
    .describe(
      "The ticket's CURRENT QR secret, used to find the order when the code is unknown. Old (replaced) secrets cannot be looked up: pretix does not log them.",
    ),
  position_id: z
    .number()
    .int()
    .optional()
    .describe(
      "The ticket's internal id (the position_id field returned by pretix_get_ticket_status, pretix_get_ticket_history and the check-in tools). Finds the order for you, and limits the history to that ticket.",
    ),
  positionid: z
    .number()
    .int()
    .optional()
    .describe(
      "Limit the history to one ticket within the order (the order's positionid field, 1-based). Omit to get every ticket in the order.",
    ),
  organizer: z.string().optional().describe("Organizer slug. Defaults to PRETIX_ORGANIZER."),
  event: z.string().optional().describe("Event slug. Defaults to PRETIX_EVENT."),
};

// Prints one JSON line prefixed with a marker, because `pretix shell` also
// prints its own banner. Inputs are prepended as JSON string literals (env vars
// would not cross a docker exec boundary).
const LOG_SCRIPT = `
import json, os
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
    order = Order.objects.get(code=PH_ORDER, event__slug=PH_EVENT)
    ct_order = ContentType.objects.get_for_model(Order)
    entries = LogEntry.objects.filter(content_type=ct_order, object_id=order.pk).order_by("datetime", "pk")
    out = []
    for e in entries:
        out.append({
            "datetime": e.datetime.isoformat(),
            "action_type": e.action_type,
            "actor": actor(e),
            "data": e.parsed_data,
        })
    print("PH_RESULT " + json.dumps(out, default=str))
`;

export interface LogRow {
  datetime: string;
  action_type: string;
  actor: string;
  data: Record<string, any>;
}

export function runPretixShell(script: string): Promise<string> {
  const custom = process.env.PRETIX_SHELL_CMD?.trim().split(/\s+/);
  const [cmd, ...args] = custom && custom[0] ? custom : ["python3", "-m", "pretix", "shell"];
  return new Promise((resolve, reject) => {
    const child = execFile(
      cmd,
      args,
      { timeout: 60_000, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const hint =
            (err as NodeJS.ErrnoException).code === "ENOENT"
              ? " Reading the order log needs pretix installed alongside this server (it runs inside the pretix container). When running elsewhere, set PRETIX_SHELL_CMD, e.g. 'docker exec -i pretix python3 -m pretix shell'."
              : "";
          reject(new Error(`Could not read the pretix order log: ${stderr.trim().split("\n").pop() || err.message}.${hint}`));
        } else {
          resolve(stdout);
        }
      },
    );
    child.stdin?.end(script);
  });
}

async function fetchLog(orderCode: string, event: string): Promise<LogRow[]> {
  const stdout = await runPretixShell(`PH_ORDER = ${JSON.stringify(orderCode)}
PH_EVENT = ${JSON.stringify(event)}
${LOG_SCRIPT}`);
  const line = stdout.split("\n").find((l) => l.startsWith("PH_RESULT "));
  if (!line) {
    throw new Error(`Order log script produced no result. Output: ${stdout.trim().slice(-500)}`);
  }
  return JSON.parse(line.slice("PH_RESULT ".length)) as LogRow[];
}

export interface HistoryEvent {
  timestamp: string;
  kind: string;
  description: string;
  actor?: string;
}

/** Which ticket (internal position pk / positionid) a log row is about, if any. */
function rowPositions(row: LogRow): { pks: number[]; positionids: number[] } {
  const pks: number[] = [];
  const positionids: number[] = [];
  const d = row.data ?? {};
  if (typeof d.position === "number") pks.push(d.position);
  if (typeof d.positionid === "number") positionids.push(d.positionid);
  if (Array.isArray(d.data)) {
    for (const item of d.data) if (item && typeof item.position === "number") pks.push(item.position);
  }
  return { pks, positionids };
}

function describeOrderRow(row: LogRow, buyer: string | null): HistoryEvent | null {
  const d = row.data ?? {};
  const base = { timestamp: row.datetime, actor: row.actor };
  switch (row.action_type) {
    case "pretix.event.order.placed":
      return { ...base, kind: "order_placed", description: `Order placed${buyer ? ` by ${buyer}` : ""}` };
    case "pretix.event.order.paid":
      return { ...base, kind: "order_paid", description: "Order marked paid" };
    case "pretix.event.order.payment.confirmed":
      return { ...base, kind: "payment", description: "Payment confirmed" };
    case "pretix.event.order.payment.canceled":
      return { ...base, kind: "payment", description: "Payment canceled" };
    case "pretix.event.order.canceled":
      return { ...base, kind: "order_canceled", description: "Order canceled (all its tickets are void)" };
    case "pretix.event.order.reactivated":
      return { ...base, kind: "order_reactivated", description: "Order reactivated" };
    case "pretix.event.order.expired":
      return { ...base, kind: "order_expired", description: "Order expired" };
    case "pretix.event.order.contact.changed":
      return {
        ...base,
        kind: "order_email_changed",
        description: `Order contact email changed from ${d.old_email ?? "?"} to ${d.new_email ?? "?"}`,
      };
    default:
      return null;
  }
}

function fmtAttendee(
  a: { name?: string | null; email?: string | null } | undefined,
  buyer: string | null,
): string {
  if (!a) return `original holder (name at purchase not logged by pretix; order buyer${buyer ? ` ${buyer}` : ""})`;
  return `${a.name ?? "no name"}${a.email ? ` <${a.email}>` : ""}`;
}

export function buildPositionHistory(position: PretixOrderPosition, rows: LogRow[], buyer: string | null) {
  const events: HistoryEvent[] = [];
  let generation = 1;
  // Attendee before the first logged change is unknown (pretix logs only the new
  // values), so the first "from" is reported as the state at order placement.
  let current: { name?: string | null; email?: string | null } | undefined;

  for (const row of rows) {
    if (row.action_type === "pretix.event.order.secret.changed") {
      generation += 1;
      events.push({
        timestamp: row.datetime,
        actor: row.actor,
        kind: "qr_reissued",
        description: `QR codes of the whole order regenerated: the previous QR stopped working. This ticket is now QR generation ${generation}`,
      });
      continue;
    }

    const refs = rowPositions(row);
    const mine =
      refs.pks.includes(position.id) ||
      (refs.pks.length === 0 && refs.positionids.includes(position.positionid));

    if (!mine) {
      const orderLevel = describeOrderRow(row, buyer);
      if (orderLevel) events.push(orderLevel);
      continue;
    }

    const base = { timestamp: row.datetime, actor: row.actor };
    const d = row.data;

    if (row.action_type === "pretix.event.order.modified") {
      for (const item of d.data ?? []) {
        if (item.position !== position.id) continue;
        if (!("attendee_name" in item) && !("attendee_email" in item)) {
          const keys = Object.keys(item).filter((k) => k !== "position");
          events.push({ ...base, kind: "details_changed", description: `Ticket details changed (${keys.join(", ") || "other fields"})` });
          continue;
        }
        const next = { name: item.attendee_name ?? current?.name, email: item.attendee_email ?? current?.email };
        if (current && next.name === current.name && next.email === current.email) continue;
        events.push({
          ...base,
          kind: "attendee_changed",
          description: `Attendee changed from ${fmtAttendee(current, buyer)} to ${fmtAttendee(next, buyer)}`,
        });
        current = next;
      }
    } else if (row.action_type === "pretix.event.order.changed.secret") {
      generation += 1;
      events.push({
        ...base,
        kind: "qr_reissued",
        description: `QR code regenerated: the previous QR stopped working. This ticket is now QR generation ${generation}`,
      });
    } else if (row.action_type === "pretix.event.checkin") {
      events.push({
        ...base,
        kind: "checkin",
        description: `${d.type === "exit" ? "Checked out" : "Checked in"} on list ${d.list ?? "?"} (QR generation ${generation}${
          d.forced ? ", forced" : ""
        })`,
      });
    } else if (row.action_type === "pretix.event.checkin.denied") {
      events.push({
        ...base,
        kind: "checkin_denied",
        description: `Scan denied (${d.errorcode ?? "unknown reason"}) on list ${d.list ?? "?"} (QR generation ${generation})`,
      });
    } else if (row.action_type === "pretix.event.order.changed.cancel") {
      events.push({ ...base, kind: "ticket_canceled", description: "This ticket was canceled (removed from the order)" });
    } else if (row.action_type === "pretix.event.order.changed.add_block") {
      events.push({ ...base, kind: "blocked", description: `Ticket blocked (${d.block_name ?? "unnamed"}): its QR is refused at check-in` });
    } else if (row.action_type === "pretix.event.order.changed.remove_block") {
      events.push({ ...base, kind: "unblocked", description: `Ticket block removed (${d.block_name ?? "unnamed"})` });
    } else if (row.action_type === "pretix.event.order.changed.item") {
      events.push({
        ...base,
        kind: "product_changed",
        description: `Product changed from item ${d.old_item}${d.old_variation ? ` (variation ${d.old_variation})` : ""} to item ${d.new_item}${d.new_variation ? ` (variation ${d.new_variation})` : ""}`,
      });
    } else if (row.action_type.startsWith("pretix.event.order.changed.")) {
      events.push({
        ...base,
        kind: row.action_type.replace("pretix.event.order.", ""),
        description: `Order change: ${row.action_type.replace("pretix.event.order.changed.", "")} ${JSON.stringify(d)}`,
      });
    } else {
      events.push({ ...base, kind: row.action_type, description: `${row.action_type} ${JSON.stringify(d)}` });
    }
  }

  events.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  // The placement entry is conceptually first even if a later row ties on timestamp.
  const placed = events.findIndex((e) => e.kind === "order_placed");
  if (placed > 0) events.unshift(...events.splice(placed, 1));

  return {
    positionid: position.positionid,
    position_id: position.id,
    item: position.item,
    variation: position.variation,
    canceled: position.canceled,
    blocked: position.blocked ?? [],
    current_attendee_name: position.attendee_name,
    current_attendee_email: position.attendee_email ?? null,
    current_secret: position.secret,
    qr_generation: generation,
    history: events,
  };
}

export async function getTicketHistory(
  client: PretixClient,
  input: { order_code?: string; secret?: string; position_id?: number; positionid?: number; organizer?: string; event?: string },
) {
  const organizer = client.organizer(input.organizer);
  const event = client.event(input.event);
  const base = `/organizers/${organizer}/events/${event}`;

  let orderCode = input.order_code;
  let positionid = input.positionid;
  if (!orderCode && input.position_id !== undefined) {
    const pos = await client.get<PretixOrderPosition>(`${base}/orderpositions/${input.position_id}/`);
    orderCode = pos.order;
    positionid = pos.positionid;
  }
  if (!orderCode) {
    if (!input.secret) throw new Error("Provide order_code, position_id or secret.");
    const found = await client.get<{ results: Array<{ order: string; positionid: number }> }>(
      `${base}/orderpositions/?secret=${encodeURIComponent(input.secret)}`,
    );
    if (found.results.length === 0) {
      throw new Error(
        "No ticket has that secret. If the QR was regenerated, the old secret no longer exists; look the ticket up by order_code instead.",
      );
    }
    orderCode = found.results[0].order;
    positionid = found.results[0].positionid;
  }

  const order = await client.get<PretixOrder>(`${base}/orders/${orderCode}/`);
  const rows = await fetchLog(order.code, event);

  // pretix logs old_email on every contact change, so the purchase-time buyer
  // email is the old_email of the first change, else the current one.
  const firstEmailChange = rows.find((r) => r.action_type === "pretix.event.order.contact.changed");
  const buyer: string | null = firstEmailChange?.data?.old_email ?? order.email;

  // The order endpoint hides canceled tickets, but their history still matters
  // ("what happened to ticket 3?"), so list every position including canceled ones.
  const withCanceled = await client.get<{ results: PretixOrderPosition[] }>(
    `${base}/orderpositions/?order=${encodeURIComponent(order.code)}&include_canceled_positions=true`,
  );
  const known = new Set(withCanceled.results.map((p) => p.id));
  let positions = [...withCanceled.results, ...order.positions.filter((p) => !known.has(p.id))].sort(
    (a, b) => a.positionid - b.positionid,
  );
  if (positionid !== undefined) {
    positions = positions.filter((p) => p.positionid === positionid);
    if (positions.length === 0) {
      throw new Error(
        `Order ${order.code} has no position ${positionid}. Positions: ${positions.map((p) => p.positionid).join(", ")}`,
      );
    }
  }

  return {
    order_code: order.code,
    status: order.status,
    email: order.email,
    note: "Ticket ids never change when a QR is regenerated or the ticket is transferred: the same order + positionid is the same ticket across all QR generations. pretix does not log the secrets themselves, so only the current secret is shown.",
    buyer_email_at_purchase: buyer,
    tickets: positions.map((p) => buildPositionHistory(p, rows, buyer)),
  };
}
