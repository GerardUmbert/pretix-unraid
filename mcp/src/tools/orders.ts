import { z } from "zod";
import type { PretixClient } from "../client.js";
import { ORDER_STATUS_LABELS, type PretixOrder, type PretixRefund } from "../types.js";

const baseOrderActionSchema = {
  order_code: z.string().describe("The pretix order code, e.g. 'ABC12'."),
  organizer: z.string().optional().describe("Organizer slug. Defaults to PRETIX_ORGANIZER."),
  event: z.string().describe("Event slug."),
  confirm: z
    .boolean()
    .describe(
      "Must be explicitly set to true to actually perform this action. Call once with confirm=false to preview the order's current state first.",
    ),
};

export const markOrderPaidInputSchema = baseOrderActionSchema;
export const markOrderPendingInputSchema = baseOrderActionSchema;
export const markOrderExpiredInputSchema = baseOrderActionSchema;
export const cancelOrderInputSchema = baseOrderActionSchema;
export const reactivateOrderInputSchema = baseOrderActionSchema;
export const extendOrderInputSchema = {
  ...baseOrderActionSchema,
  new_expiry_date: z
    .string()
    .describe("New payment deadline, ISO 8601 date or datetime, e.g. '2026-12-31'."),
};

export const approveOrderInputSchema = baseOrderActionSchema;
export const denyOrderInputSchema = {
  ...baseOrderActionSchema,
  comment: z.string().optional().describe("Optional comment explaining the denial."),
  send_email: z
    .boolean()
    .describe("Whether to email the customer about the denial. Must be set explicitly."),
};

const MAX_LIST_PAGES = 20;

export const listOrdersInputSchema = {
  organizer: z.string().optional().describe("Organizer slug. Defaults to PRETIX_ORGANIZER."),
  event: z.string().describe("Event slug."),
  status: z
    .enum(["n", "p", "e", "c"])
    .optional()
    .describe("Filter by status: n=pending, p=paid, e=expired, c=canceled."),
  email: z.string().optional().describe("Filter by exact customer email."),
  search: z.string().optional().describe("Free-text search (order code, attendee name, etc)."),
  page: z.number().int().optional().describe("Page number, 1-based. Omit to fetch all pages up to the cap."),
};

export const createOrderInputSchema = {
  organizer: z.string().optional().describe("Organizer slug. Defaults to PRETIX_ORGANIZER."),
  event: z.string().describe("Event slug."),
  email: z.string().describe("Customer email."),
  status: z
    .enum(["n", "p"])
    .describe("Initial order status: n=pending, p=paid (skips the pending step)."),
  customer_id: z
    .string()
    .optional()
    .describe("Customer account identifier (from pretix_create_customer / pretix_list_customers) to link this order to."),
  send_email: z
    .boolean()
    .describe("Whether pretix should email the customer about this order. Must be set explicitly — wrong value can double-notify a real attendee if the order was already communicated elsewhere."),
  positions: z
    .array(
      z.object({
        item: z.number().int().describe("Item (product) ID."),
        price: z.string().describe("Price for this position, e.g. '10.00'."),
        attendee_name: z.string().optional().describe("Attendee name for this position."),
        attendee_email: z.string().optional().describe("Attendee email for this position."),
        variation: z.number().int().optional().describe("Variation ID, required if the item has variations (from pretix_list_variations)."),
        seat: z
          .string()
          .optional()
          .describe("Seat GUID to assign (from pretix_list_seats). The event needs a seating plan and the item must be mapped to the seat's category."),
        answers: z
          .array(
            z.object({
              question: z.number().int().describe("Question ID (from pretix_list_questions)."),
              answer: z.string().describe("The answer text, e.g. a dietary note or accessibility request."),
              options: z
                .array(z.number().int())
                .optional()
                .describe("Option IDs, required for choice / multiple-choice questions."),
            }),
          )
          .optional()
          .describe("Answers to custom questions for this position, e.g. table number, dietary restrictions, accessibility needs."),
        secret: z
          .string()
          .optional()
          .describe(
            "Custom ticket secret/QR value for this position. Use this to preserve a ticket ID an external system already generated, instead of letting pretix generate a new one.",
          ),
      }),
    )
    .min(1)
    .describe("At least one position (ticket) to create in this order."),
  code: z
    .string()
    .optional()
    .describe("Custom order code (A-Z, 0-9, excluding O and 1). Omit to let pretix generate one."),
  comment: z
    .string()
    .optional()
    .describe("Internal staff note on the order (not shown to the buyer), e.g. a special request received by phone."),
  confirm: z
    .boolean()
    .describe("Must be explicitly set to true to actually create the order. Call once with confirm=false to preview what would be created."),
};

export const listRefundsInputSchema = {
  order_code: z.string().describe("The pretix order code, e.g. 'ABC12'."),
  organizer: z.string().optional().describe("Organizer slug. Defaults to PRETIX_ORGANIZER."),
  event: z.string().describe("Event slug."),
};

export const issueRefundInputSchema = {
  order_code: z.string().describe("The pretix order code, e.g. 'ABC12'."),
  organizer: z.string().optional().describe("Organizer slug. Defaults to PRETIX_ORGANIZER."),
  event: z.string().describe("Event slug."),
  amount: z
    .string()
    .describe(
      "Refund amount, e.g. '10.00'. This tool checks this against the order's total before proceeding, since pretix's own API does NOT validate the refund amount against what's actually owed.",
    ),
  comment: z.string().optional().describe("Optional internal comment explaining the refund."),
  confirm: z
    .boolean()
    .describe("Must be explicitly set to true to actually issue the refund. Call once with confirm=false to preview first."),
};

export const downloadTicketInputSchema = {
  order_code: z.string().describe("The pretix order code, e.g. 'ABC12'."),
  organizer: z.string().optional().describe("Organizer slug. Defaults to PRETIX_ORGANIZER."),
  event: z.string().describe("Event slug."),
  output: z.string().default("pdf").describe("Ticket output provider, e.g. 'pdf'."),
};

async function fetchOrder(
  client: PretixClient,
  organizer: string,
  event: string,
  code: string,
): Promise<PretixOrder> {
  return client.get<PretixOrder>(`/organizers/${organizer}/events/${event}/orders/${code}/`);
}

function orderPreview(order: PretixOrder) {
  return {
    order_code: order.code,
    current_status: order.status,
    current_status_label: ORDER_STATUS_LABELS[order.status],
    total: order.total,
    email: order.email,
  };
}

/**
 * Shared implementation for the simple order-state-transition actions
 * (mark_paid, mark_pending, mark_canceled, mark_expired, reactivate) -
 * they're all: fetch order, preview-or-confirm, POST to an action
 * endpoint with no body, report new status. Don't duplicate this per
 * action; add a new exported wrapper function instead (see below).
 */
async function performOrderAction(
  client: PretixClient,
  input: { order_code: string; organizer?: string; event?: string; confirm: boolean },
  actionPath: string,
  dryRunVerb: string,
) {
  const organizer = client.organizer(input.organizer);
  const event = client.event(input.event);
  const order = await fetchOrder(client, organizer, event, input.order_code);

  if (!input.confirm) {
    return {
      performed: false,
      message: `Dry run — no change made. Re-call with confirm=true to ${dryRunVerb}.`,
      order: orderPreview(order),
    };
  }

  const updated = await client.post<PretixOrder>(
    `/organizers/${organizer}/events/${event}/orders/${order.code}/${actionPath}/`,
  );

  return {
    performed: true,
    order_code: updated.code,
    new_status: updated.status,
    new_status_label: ORDER_STATUS_LABELS[updated.status],
  };
}

export function markOrderPaid(client: PretixClient, input: Parameters<typeof performOrderAction>[1]) {
  return performOrderAction(client, input, "mark_paid", "mark this order paid");
}

export function markOrderPending(client: PretixClient, input: Parameters<typeof performOrderAction>[1]) {
  return performOrderAction(client, input, "mark_pending", "mark this order pending");
}

export function markOrderExpired(client: PretixClient, input: Parameters<typeof performOrderAction>[1]) {
  return performOrderAction(client, input, "mark_expired", "mark this order expired");
}

export function cancelOrder(client: PretixClient, input: Parameters<typeof performOrderAction>[1]) {
  return performOrderAction(client, input, "mark_canceled", "cancel this order");
}

export function reactivateOrder(client: PretixClient, input: Parameters<typeof performOrderAction>[1]) {
  return performOrderAction(client, input, "reactivate", "reactivate this canceled order");
}

export async function extendOrder(
  client: PretixClient,
  input: { order_code: string; organizer?: string; event?: string; confirm: boolean; new_expiry_date: string },
) {
  const organizer = client.organizer(input.organizer);
  const event = client.event(input.event);
  const order = await fetchOrder(client, organizer, event, input.order_code);

  if (!input.confirm) {
    return {
      performed: false,
      message: `Dry run — no change made. Re-call with confirm=true to extend this order's payment deadline to ${input.new_expiry_date}.`,
      order: orderPreview(order),
    };
  }

  const updated = await client.post<PretixOrder>(
    `/organizers/${organizer}/events/${event}/orders/${order.code}/extend/`,
    { expires: input.new_expiry_date },
  );

  return {
    performed: true,
    order_code: updated.code,
    new_status: updated.status,
    new_status_label: ORDER_STATUS_LABELS[updated.status],
  };
}

export async function approveOrder(
  client: PretixClient,
  input: { order_code: string; organizer?: string; event?: string; confirm: boolean },
) {
  return performOrderAction(client, input, "approve", "approve this order");
}

export async function denyOrder(
  client: PretixClient,
  input: {
    order_code: string;
    organizer?: string;
    event?: string;
    confirm: boolean;
    comment?: string;
    send_email: boolean;
  },
) {
  const organizer = client.organizer(input.organizer);
  const event = client.event(input.event);
  const order = await fetchOrder(client, organizer, event, input.order_code);

  if (!input.confirm) {
    return {
      performed: false,
      message: "Dry run — no change made. Re-call with confirm=true to deny this order.",
      order: orderPreview(order),
    };
  }

  const updated = await client.post<PretixOrder>(
    `/organizers/${organizer}/events/${event}/orders/${order.code}/deny/`,
    { send_email: input.send_email, comment: input.comment },
  );

  return {
    performed: true,
    order_code: updated.code,
    new_status: updated.status,
    new_status_label: ORDER_STATUS_LABELS[updated.status],
  };
}

export async function listOrders(
  client: PretixClient,
  input: {
    organizer?: string;
    event: string;
    status?: "n" | "p" | "e" | "c";
    email?: string;
    search?: string;
    page?: number;
  },
) {
  const organizer = client.organizer(input.organizer);
  const params = new URLSearchParams();
  if (input.status) params.set("status", input.status);
  if (input.email) params.set("email", input.email);
  if (input.search) params.set("search", input.search);
  if (input.page) params.set("page", String(input.page));

  type Page = { count: number; next: string | null; results: PretixOrder[] };
  const fetchPage = (n?: number) => {
    const p = new URLSearchParams(params);
    if (n) p.set("page", String(n));
    const query = p.toString();
    return client.get<Page>(`/organizers/${organizer}/events/${input.event}/orders/${query ? `?${query}` : ""}`);
  };

  // An explicit page returns just that page; otherwise follow every page (capped).
  const first = await fetchPage(input.page);
  const results = [...first.results];
  let next = first.next;
  for (let n = 2; !input.page && next && n <= MAX_LIST_PAGES; n++) {
    const res = await fetchPage(n);
    results.push(...res.results);
    next = res.next;
  }

  return {
    count: first.count,
    returned: results.length,
    has_more_pages: next !== null,
    orders: results.map((o) => orderPreview(o)),
  };
}

export async function createOrder(
  client: PretixClient,
  input: {
    organizer?: string;
    event: string;
    email: string;
    status: "n" | "p";
    send_email: boolean;
    positions: Array<{
      item: number;
      price: string;
      attendee_name?: string;
      attendee_email?: string;
      variation?: number;
      seat?: string;
      answers?: Array<{ question: number; answer: string; options?: number[] }>;
      secret?: string;
    }>;
    comment?: string;
    customer_id?: string;
    code?: string;
    confirm: boolean;
  },
) {
  const organizer = client.organizer(input.organizer);

  const preview = {
    event: input.event,
    email: input.email,
    status: input.status,
    position_count: input.positions.length,
    positions: input.positions,
    customer_id: input.customer_id ?? null,
    code: input.code ?? "(auto-generated)",
    comment: input.comment ?? null,
  };

  if (!input.confirm) {
    return {
      performed: false,
      message: "Dry run — no order created. Re-call with confirm=true to actually create it.",
      would_create: preview,
    };
  }

  // API-created orders are only flagged as test orders when asked; in a
  // test-mode event that flag is what lets them be deleted again later.
  const { testmode } = await client.get<{ testmode: boolean }>(`/organizers/${organizer}/events/${input.event}/`);

  const created = await client.post<PretixOrder>(`/organizers/${organizer}/events/${input.event}/orders/`, {
    ...(testmode ? { testmode: true } : {}),
    email: input.email,
    locale: "en",
    sales_channel: "web",
    fees: [],
    status: input.status,
    payment_provider: "manual",
    invoice_address: {},
    ...(input.customer_id ? { customer: input.customer_id } : {}),
    send_email: input.send_email,
    code: input.code,
    ...(input.comment ? { comment: input.comment } : {}),
    positions: input.positions,
  });

  return {
    performed: true,
    order_code: created.code,
    status: created.status,
    status_label: ORDER_STATUS_LABELS[created.status],
    positions: created.positions.map((p) => ({
      positionid: p.positionid,
      attendee_name: p.attendee_name,
      variation: p.variation,
      seat: p.seat ? { name: p.seat.name, seat_guid: p.seat.seat_guid } : null,
      answers: p.answers ?? [],
      secret: p.secret,
    })),
  };
}

export async function listRefunds(
  client: PretixClient,
  input: { order_code: string; organizer?: string; event: string },
) {
  const organizer = client.organizer(input.organizer);
  const order = await fetchOrder(client, organizer, input.event, input.order_code);
  return {
    order_code: order.code,
    total: order.total,
    refunds: order.refunds,
  };
}

export async function issueRefund(
  client: PretixClient,
  input: {
    order_code: string;
    organizer?: string;
    event: string;
    amount: string;
    comment?: string;
    confirm: boolean;
  },
) {
  const organizer = client.organizer(input.organizer);
  const order = await fetchOrder(client, organizer, input.event, input.order_code);

  const totalPaid = parseFloat(order.total);
  const alreadyRefunded = order.refunds
    .filter((r) => r.state === "done" || r.state === "transit")
    .reduce((sum, r) => sum + parseFloat(r.amount), 0);
  const requestedAmount = parseFloat(input.amount);
  const remainingRefundable = totalPaid - alreadyRefunded;

  if (requestedAmount > remainingRefundable) {
    throw new Error(
      `Refund amount ${input.amount} exceeds what's left to refund on this order. ` +
        `Order total: ${order.total}, already refunded: ${alreadyRefunded.toFixed(2)}, ` +
        `remaining refundable: ${remainingRefundable.toFixed(2)}. pretix's own API does not ` +
        `check this, so this tool refuses instead of issuing an incorrect refund.`,
    );
  }

  const preview = {
    order_code: order.code,
    order_total: order.total,
    already_refunded: alreadyRefunded.toFixed(2),
    requested_amount: input.amount,
    remaining_refundable_after: (remainingRefundable - requestedAmount).toFixed(2),
  };

  if (!input.confirm) {
    return {
      performed: false,
      message: "Dry run — no refund issued. Re-call with confirm=true to actually issue it.",
      would_refund: preview,
    };
  }

  const refund = await client.post<PretixRefund>(
    `/organizers/${organizer}/events/${input.event}/orders/${order.code}/refunds/`,
    {
      state: "created",
      source: "admin",
      amount: input.amount,
      provider: "manual",
      comment: input.comment,
      mark_canceled: false,
    },
  );

  return {
    performed: true,
    order_code: order.code,
    refund_local_id: refund.local_id,
    refund_state: refund.state,
    amount: refund.amount,
  };
}

export async function downloadTicket(
  client: PretixClient,
  input: { order_code: string; organizer?: string; event: string; output: string },
) {
  const organizer = client.organizer(input.organizer);
  try {
    const result = await client.get<unknown>(
      `/organizers/${organizer}/events/${input.event}/orders/${input.order_code}/download/${input.output}/`,
    );
    return { ready: true, order_code: input.order_code, output: input.output, result };
  } catch (err) {
    return {
      ready: false,
      order_code: input.order_code,
      output: input.output,
      message:
        "Ticket file is not ready yet (pretix generates it asynchronously). Try again shortly.",
    };
  }
}
