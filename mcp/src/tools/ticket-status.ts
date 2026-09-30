import { z } from "zod";
import type { PretixClient } from "../client.js";
import {
  ORDER_STATUS_LABELS,
  type PretixOrder,
  type TimelineEntry,
} from "../types.js";

export const ticketStatusInputSchema = {
  order_code: z
    .string()
    .describe("The pretix order code, e.g. 'ABC12'. Required unless secret is given instead."),
  organizer: z.string().optional().describe("Organizer slug. Defaults to PRETIX_ORGANIZER."),
  event: z.string().optional().describe("Event slug. Defaults to PRETIX_EVENT."),
};

function buildTimeline(order: PretixOrder): TimelineEntry[] {
  const entries: TimelineEntry[] = [
    {
      timestamp: order.datetime,
      kind: "order_placed",
      description: `Order ${order.code} placed (email: ${order.email ?? "none"})`,
    },
  ];

  for (const payment of order.payments) {
    entries.push({
      timestamp: payment.payment_date ?? payment.created,
      kind: "payment",
      description: `Payment ${payment.local_id} via ${payment.provider}: ${payment.state} (${payment.amount})`,
    });
  }

  for (const refund of order.refunds) {
    entries.push({
      timestamp: refund.execution_date ?? refund.created,
      kind: "refund",
      description: `Refund ${refund.local_id} (${refund.source}): ${refund.state} (${refund.amount})${
        refund.comment ? ` — ${refund.comment}` : ""
      }`,
    });
  }

  for (const position of order.positions) {
    for (const checkin of position.checkins) {
      entries.push({
        timestamp: checkin.datetime,
        kind: "checkin",
        description: `Position ${position.positionid} (${position.attendee_name ?? "no name"}): ${checkin.type} on list ${checkin.list}`,
      });
    }
  }

  // Sort by time, but order_placed always comes first even if a payment's
  // timestamp lands a few milliseconds earlier (observed with orders
  // created already-paid, where payment.created can precede order.datetime
  // by a hair) - it's conceptually the start of the timeline regardless.
  entries.sort((a, b) => {
    if (a.kind === "order_placed") return -1;
    if (b.kind === "order_placed") return 1;
    return new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
  });
  return entries;
}

export async function getTicketStatus(
  client: PretixClient,
  input: { order_code: string; organizer?: string; event?: string },
) {
  const organizer = client.organizer(input.organizer);
  const event = client.event(input.event);

  const order = await client.get<PretixOrder>(
    `/organizers/${organizer}/events/${event}/orders/${input.order_code}/`,
  );

  const timeline = buildTimeline(order);

  return {
    order_code: order.code,
    status: order.status,
    status_label: ORDER_STATUS_LABELS[order.status],
    email: order.email,
    comment: order.comment ?? "",
    total: order.total,
    last_modified: order.last_modified,
    positions: order.positions.map((p) => ({
      position_id: p.id,
      positionid: p.positionid,
      attendee_name: p.attendee_name,
      item: p.item,
      variation: p.variation,
      seat: p.seat ? { name: p.seat.name, seat_guid: p.seat.seat_guid } : null,
      answers: p.answers ?? [],
      canceled: p.canceled,
      currently_checked_in:
        p.checkins.length > 0 && p.checkins[p.checkins.length - 1].type === "entry",
      checkin_count: p.checkins.length,
    })),
    timeline,
  };
}
