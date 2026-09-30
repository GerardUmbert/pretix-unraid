import { z } from "zod";
import type { PretixClient } from "../client.js";
import type { CheckinRedeemResponse, PretixOrderPosition } from "../types.js";

export const listCheckinListsInputSchema = {
  organizer: z.string().optional().describe("Organizer slug. Defaults to PRETIX_ORGANIZER."),
  event: z.string().describe("Event slug."),
};

export const getCheckinStatusInputSchema = {
  organizer: z.string().optional().describe("Organizer slug. Defaults to PRETIX_ORGANIZER."),
  event: z.string().describe("Event slug."),
  list_id: z.number().int().describe("Check-in list ID (from pretix_list_checkin_lists)."),
};

export const listCheckinPositionsInputSchema = {
  organizer: z.string().optional().describe("Organizer slug. Defaults to PRETIX_ORGANIZER."),
  event: z.string().describe("Event slug."),
  list_id: z.number().int().describe("Check-in list ID (from pretix_list_checkin_lists)."),
  search: z.string().optional().describe("Free-text search, e.g. attendee name or order code."),
};

export const checkinBySecretInputSchema = {
  organizer: z.string().optional().describe("Organizer slug. Defaults to PRETIX_ORGANIZER."),
  list_ids: z
    .array(z.number().int())
    .min(1)
    .describe("Check-in list IDs to attempt this scan against (from pretix_list_checkin_lists)."),
  secret: z.string().describe("The ticket's secret/QR code value, as scanned."),
  type: z.enum(["entry", "exit"]).default("entry").describe("Whether this is an entry or exit scan."),
};

export const createCheckinListInputSchema = {
  organizer: z.string().optional().describe("Organizer slug. Defaults to PRETIX_ORGANIZER."),
  event: z.string().describe("Event slug."),
  name: z.string().describe("Check-in list name, e.g. 'Main entrance'."),
  all_products: z.boolean().default(true).describe("Whether the list accepts every product, or only limit_item_ids."),
  limit_item_ids: z.array(z.number().int()).optional().describe("Item IDs this list accepts, if all_products is false."),
  confirm: z
    .boolean()
    .describe("Must be explicitly set to true to actually create the check-in list. Call once with confirm=false to preview first."),
};

interface PretixCheckinList {
  id: number;
  name: string;
  all_products: boolean;
  checkin_count: number;
  position_count: number;
}

export async function createCheckinList(
  client: PretixClient,
  input: {
    organizer?: string;
    event: string;
    name: string;
    all_products: boolean;
    limit_item_ids?: number[];
    confirm: boolean;
  },
) {
  const organizer = client.organizer(input.organizer);

  const body = {
    name: input.name,
    all_products: input.all_products,
    limit_products: input.limit_item_ids ?? [],
  };

  if (!input.confirm) {
    return {
      performed: false,
      message: "Dry run — no check-in list created. Re-call with confirm=true to actually create it.",
      would_create: body,
    };
  }

  const created = await client.post<PretixCheckinList>(
    `/organizers/${organizer}/events/${input.event}/checkinlists/`,
    body,
  );
  return { performed: true, list_id: created.id, name: created.name };
}

export async function listCheckinLists(
  client: PretixClient,
  input: { organizer?: string; event: string },
) {
  const organizer = client.organizer(input.organizer);
  const result = await client.get<{ results: PretixCheckinList[] }>(
    `/organizers/${organizer}/events/${input.event}/checkinlists/`,
  );
  return { checkin_lists: result.results };
}

interface PretixCheckinStatus {
  checkin_count: number;
  position_count: number;
  inside_count: number;
}

export async function getCheckinStatus(
  client: PretixClient,
  input: { organizer?: string; event: string; list_id: number },
) {
  const organizer = client.organizer(input.organizer);
  const status = await client.get<PretixCheckinStatus>(
    `/organizers/${organizer}/events/${input.event}/checkinlists/${input.list_id}/status/`,
  );
  return status;
}

export async function listCheckinPositions(
  client: PretixClient,
  input: { organizer?: string; event: string; list_id: number; search?: string },
) {
  const organizer = client.organizer(input.organizer);
  const params = new URLSearchParams();
  if (input.search) params.set("search", input.search);
  const query = params.toString();

  const result = await client.get<{ count: number; results: PretixOrderPosition[] }>(
    `/organizers/${organizer}/events/${input.event}/checkinlists/${input.list_id}/positions/${
      query ? `?${query}` : ""
    }`,
  );

  return {
    count: result.count,
    positions: result.results.map((p) => ({
      order: p.order,
      positionid: p.positionid,
      attendee_name: p.attendee_name,
      canceled: p.canceled,
      checkin_count: p.checkins.length,
    })),
  };
}

const REDEEM_REASON_EXPLANATIONS: Record<string, string> = {
  invalid: "This ticket secret is not recognized — it may be mistyped, revoked, or for a different event.",
  unpaid: "This ticket's order has not been paid yet.",
  blocked: "This ticket is blocked and cannot be used for check-in.",
  invalid_time: "This ticket is not valid at the current time (outside its valid window).",
  canceled: "This ticket's order or position has been canceled.",
  already_redeemed: "This ticket has already been checked in.",
  product: "This ticket's product is not allowed on this check-in list.",
  rules: "This ticket does not satisfy this check-in list's custom rules.",
  ambiguous: "This secret matches more than one ticket — cannot proceed automatically.",
  revoked: "This ticket secret has been explicitly revoked.",
};

export async function checkinBySecret(
  client: PretixClient,
  input: { organizer?: string; list_ids: number[]; secret: string; type: "entry" | "exit" },
) {
  const organizer = client.organizer(input.organizer);

  const response = await client.post<CheckinRedeemResponse>(
    `/organizers/${organizer}/checkinrpc/redeem/`,
    { secret: input.secret, lists: input.list_ids, type: input.type },
  );

  if (response.status === "ok") {
    return {
      success: true,
      attendee_name: response.position?.attendee_name,
      order: response.position?.order,
      positionid: response.position?.positionid,
    };
  }

  return {
    success: false,
    reason: response.reason,
    explanation: response.reason ? REDEEM_REASON_EXPLANATIONS[response.reason] : response.detail,
    attendee_name: response.position?.attendee_name,
    order: response.position?.order,
  };
}
