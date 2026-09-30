import { z } from "zod";
import type { PretixClient } from "../client.js";
import { ORDER_STATUS_LABELS, type PretixOrder } from "../types.js";

const baseOrderActionSchema = {
  order_code: z.string().describe("The pretix order code, e.g. 'ABC12'."),
  organizer: z.string().optional().describe("Organizer slug. Defaults to PRETIX_ORGANIZER."),
  event: z.string().optional().describe("Event slug. Defaults to PRETIX_EVENT."),
  confirm: z
    .boolean()
    .describe(
      "Must be explicitly set to true to actually perform this action. Call once with confirm=false to preview the order's current state first.",
    ),
};

export const markOrderPaidInputSchema = baseOrderActionSchema;
export const cancelOrderInputSchema = baseOrderActionSchema;

async function fetchOrder(
  client: PretixClient,
  organizer: string,
  event: string,
  code: string,
): Promise<PretixOrder> {
  return client.get<PretixOrder>(`/organizers/${organizer}/events/${event}/orders/${code}/`);
}

export async function markOrderPaid(
  client: PretixClient,
  input: { order_code: string; organizer?: string; event?: string; confirm: boolean },
) {
  const organizer = client.organizer(input.organizer);
  const event = client.event(input.event);
  const order = await fetchOrder(client, organizer, event, input.order_code);

  const preview = {
    order_code: order.code,
    current_status: order.status,
    current_status_label: ORDER_STATUS_LABELS[order.status],
    total: order.total,
    email: order.email,
  };

  if (!input.confirm) {
    return {
      performed: false,
      message: "Dry run — no change made. Re-call with confirm=true to mark this order paid.",
      order: preview,
    };
  }

  const updated = await client.post<PretixOrder>(
    `/organizers/${organizer}/events/${event}/orders/${order.code}/mark_paid/`,
  );

  return {
    performed: true,
    order_code: updated.code,
    new_status: updated.status,
    new_status_label: ORDER_STATUS_LABELS[updated.status],
  };
}

export async function cancelOrder(
  client: PretixClient,
  input: { order_code: string; organizer?: string; event?: string; confirm: boolean },
) {
  const organizer = client.organizer(input.organizer);
  const event = client.event(input.event);
  const order = await fetchOrder(client, organizer, event, input.order_code);

  const preview = {
    order_code: order.code,
    current_status: order.status,
    current_status_label: ORDER_STATUS_LABELS[order.status],
    total: order.total,
    email: order.email,
  };

  if (!input.confirm) {
    return {
      performed: false,
      message: "Dry run — no change made. Re-call with confirm=true to cancel this order.",
      order: preview,
    };
  }

  const updated = await client.post<PretixOrder>(
    `/organizers/${organizer}/events/${event}/orders/${order.code}/mark_canceled/`,
  );

  return {
    performed: true,
    order_code: updated.code,
    new_status: updated.status,
    new_status_label: ORDER_STATUS_LABELS[updated.status],
  };
}
