import { z } from "zod";
import type { PretixClient } from "../client.js";
import { ORDER_STATUS_LABELS, type PretixOrder } from "../types.js";
import { MAX_PAGES } from "./paging.js";

// pretix computes "overpaid" / "underpaid" only for its admin UI filter; the
// REST API order filter takes just n/p/e/c. Each order does carry its total,
// payments and refunds, so the same arithmetic is done here.


export const paymentIssuesInputSchema = {
  organizer: z.string().optional().describe("Organizer slug. Defaults to PRETIX_ORGANIZER."),
  event: z.string().describe("Event slug."),
  kind: z
    .enum(["overpaid", "underpaid", "partially_paid", "money_held_on_dead_order"])
    .optional()
    .describe("Only return one kind of issue. Omit to return all kinds."),
};

const cents = (v: string | null | undefined) => Math.round(Number(v ?? 0) * 100);
const fmt = (c: number) => (c / 100).toFixed(2);

type IssueKind = "overpaid" | "underpaid" | "partially_paid" | "money_held_on_dead_order";

function classify(order: PretixOrder) {
  const total = cents(order.total);
  const confirmed = order.payments.filter((p) => p.state === "confirmed");
  // Refunds that have been (or are being) paid out reduce what the customer has net paid.
  const refunded = order.refunds.filter((r) => ["done", "transit", "external"].includes(r.state));
  const paid = confirmed.reduce((s, p) => s + cents(p.amount), 0);
  const back = refunded.reduce((s, r) => s + cents(r.amount), 0);
  const net = paid - back;

  let kind: IssueKind | null = null;
  let explanation = "";
  if (order.status === "p") {
    if (net > total) {
      kind = "overpaid";
      explanation = `Paid order has ${fmt(net)} net received but the total is ${fmt(total)}: ${fmt(net - total)} too much.`;
    } else if (net < total) {
      kind = "underpaid";
      explanation = `Paid order has only ${fmt(net)} net received for a total of ${fmt(total)}: ${fmt(total - net)} missing.`;
    }
  } else if (order.status === "n") {
    if (net > total) {
      kind = "overpaid";
      explanation = `Pending order already has ${fmt(net)} received, more than the total ${fmt(total)}.`;
    } else if (net > 0) {
      kind = "partially_paid";
      explanation = `Pending order has ${fmt(net)} of ${fmt(total)} received.`;
    }
  } else if (net > 0) {
    // Canceled or expired: whatever was received is owed back, except a cancellation fee pretix keeps (not visible through the API).
    kind = "money_held_on_dead_order";
    explanation = `${ORDER_STATUS_LABELS[order.status]} order still holds ${fmt(net)} net received. Refund it unless a cancellation fee applies.`;
  }
  if (!kind) return null;

  return {
    order_code: order.code,
    status: ORDER_STATUS_LABELS[order.status],
    kind,
    email: order.email,
    total: fmt(total),
    confirmed_payments: fmt(paid),
    refunds_paid_or_in_transit: fmt(back),
    net_received: fmt(net),
    difference: fmt(net - total),
    explanation,
    payments: order.payments.map((p) => ({ id: p.local_id, provider: p.provider, state: p.state, amount: p.amount })),
    refunds: order.refunds.map((r) => ({ id: r.local_id, state: r.state, amount: r.amount })),
  };
}

export async function findPaymentIssues(
  client: PretixClient,
  input: { organizer?: string; event: string; kind?: IssueKind },
) {
  const organizer = client.organizer(input.organizer);
  const base = `/organizers/${organizer}/events/${input.event}/orders/`;

  const all: PretixOrder[] = [];
  let truncated = false;
  for (let page = 1; ; page++) {
    if (page > MAX_PAGES) {
      truncated = true;
      break;
    }
    const res = await client.get<{ next: string | null; results: PretixOrder[] }>(`${base}?page=${page}`);
    all.push(...res.results);
    if (!res.next) break;
  }

  const issues = all.map(classify).filter((i): i is NonNullable<ReturnType<typeof classify>> => i !== null);
  const filtered = input.kind ? issues.filter((i) => i.kind === input.kind) : issues;

  const counts: Record<string, number> = {};
  for (const i of issues) counts[i.kind] = (counts[i.kind] ?? 0) + 1;

  return {
    orders_scanned: all.length,
    scan_complete: !truncated,
    issue_counts: counts,
    issues: filtered,
  };
}
