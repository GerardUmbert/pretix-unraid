// Shapes confirmed against a real pretix instance's API responses
// (see plans/mcp-server.md in the pretix-unraid repo for the verification
// transcript) — not guessed from docs alone.

export type OrderStatus = "n" | "p" | "e" | "c";

export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  n: "pending",
  p: "paid",
  e: "expired",
  c: "canceled",
};

export interface PretixPayment {
  local_id: number;
  state: "created" | "pending" | "confirmed" | "canceled" | "failed" | "refunded";
  amount: string;
  created: string;
  payment_date: string | null;
  provider: string;
}

export interface PretixRefund {
  local_id: number;
  state: "created" | "transit" | "external" | "canceled" | "failed" | "done";
  source: "buyer" | "admin" | "external";
  amount: string;
  created: string;
  execution_date: string | null;
  comment: string | null;
  provider: string;
}

export interface PretixCheckin {
  id: number;
  datetime: string;
  list: number;
  type: "entry" | "exit";
  gate: number | null;
  device: number | null;
  auto_checked_in: boolean;
}

export interface PretixOrderPosition {
  id: number;
  order: string;
  positionid: number;
  item: number;
  variation: number | null;
  price: string;
  attendee_name: string | null;
  attendee_email?: string | null;
  secret: string;
  canceled: boolean;
  checkins: PretixCheckin[];
}

export interface PretixOrder {
  code: string;
  event: string;
  status: OrderStatus;
  email: string | null;
  datetime: string;
  last_modified: string;
  total: string;
  payments: PretixPayment[];
  refunds: PretixRefund[];
  positions: PretixOrderPosition[];
}

export type CheckinRedeemStatus =
  | "ok"
  | "invalid"
  | "unpaid"
  | "blocked"
  | "invalid_time"
  | "canceled"
  | "already_redeemed"
  | "product"
  | "rules"
  | "ambiguous"
  | "revoked";

export interface CheckinRedeemResponse {
  status: "ok" | "error";
  reason?: CheckinRedeemStatus;
  detail?: string;
  position?: PretixOrderPosition;
}

export interface TimelineEntry {
  timestamp: string;
  kind: "order_placed" | "payment" | "refund" | "checkin";
  description: string;
}
