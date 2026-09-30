import { z } from "zod";
import type { PretixClient } from "../client.js";

export const listVouchersInputSchema = {
  organizer: z.string().optional().describe("Organizer slug. Defaults to PRETIX_ORGANIZER."),
  event: z.string().describe("Event slug."),
};

export const getVoucherInputSchema = {
  organizer: z.string().optional().describe("Organizer slug. Defaults to PRETIX_ORGANIZER."),
  event: z.string().describe("Event slug."),
  voucher_id: z.number().int().describe("Voucher ID."),
};

export const createVoucherInputSchema = {
  organizer: z.string().optional().describe("Organizer slug. Defaults to PRETIX_ORGANIZER."),
  event: z.string().describe("Event slug."),
  code: z.string().optional().describe("Custom redemption code. Omit to let pretix generate one."),
  max_usages: z.number().int().default(1).describe("Maximum number of times this voucher can be redeemed."),
  value: z.string().optional().describe("Numeric value applied per price_mode, e.g. '5.00' or '10' for 10%."),
  price_mode: z
    .enum(["none", "set", "subtract", "percent"])
    .default("none")
    .describe("How value affects pricing: none, set (fixed price), subtract, or percent."),
  valid_until: z.string().optional().describe("Expiration datetime, ISO 8601. Omit for no expiration."),
  item_id: z.number().int().optional().describe("Restrict this voucher to one item, if any."),
  tag: z.string().optional().describe("Grouping label for this voucher."),
  confirm: z
    .boolean()
    .describe("Must be explicitly set to true to actually create the voucher. Call once with confirm=false to preview first."),
};

export const batchCreateVouchersInputSchema = {
  organizer: z.string().optional().describe("Organizer slug. Defaults to PRETIX_ORGANIZER."),
  event: z.string().describe("Event slug."),
  count: z.number().int().min(1).max(500).describe("How many vouchers to generate."),
  max_usages: z.number().int().default(1).describe("Maximum redemptions per voucher."),
  value: z.string().optional().describe("Numeric value applied per price_mode."),
  price_mode: z
    .enum(["none", "set", "subtract", "percent"])
    .default("none")
    .describe("How value affects pricing."),
  valid_until: z.string().optional().describe("Expiration datetime, ISO 8601."),
  item_id: z.number().int().optional().describe("Restrict these vouchers to one item, if any."),
  tag: z.string().optional().describe("Grouping label applied to all generated vouchers."),
  confirm: z
    .boolean()
    .describe("Must be explicitly set to true to actually create the vouchers. Call once with confirm=false to preview first."),
};

export const updateVoucherInputSchema = {
  organizer: z.string().optional().describe("Organizer slug. Defaults to PRETIX_ORGANIZER."),
  event: z.string().describe("Event slug."),
  voucher_id: z.number().int().describe("Voucher ID to update."),
  max_usages: z.number().int().optional().describe("New max usages, if changing."),
  valid_until: z.string().optional().describe("New expiration datetime, if changing."),
  confirm: z
    .boolean()
    .describe("Must be explicitly set to true to actually update the voucher. Call once with confirm=false to preview first."),
};

export const deleteVoucherInputSchema = {
  organizer: z.string().optional().describe("Organizer slug. Defaults to PRETIX_ORGANIZER."),
  event: z.string().describe("Event slug."),
  voucher_id: z.number().int().describe("Voucher ID to delete."),
  confirm: z
    .boolean()
    .describe("Must be explicitly set to true to actually delete the voucher. Call once with confirm=false to preview first."),
};

export const listDiscountsInputSchema = {
  organizer: z.string().optional().describe("Organizer slug. Defaults to PRETIX_ORGANIZER."),
  event: z.string().describe("Event slug."),
};

export const listGiftCardsInputSchema = {
  organizer: z.string().optional().describe("Organizer slug. Defaults to PRETIX_ORGANIZER."),
};

interface PretixVoucher {
  id: number;
  code: string;
  max_usages: number;
  redeemed: number;
  value: string | null;
  price_mode: string;
  valid_until: string | null;
  item: number | null;
  tag: string | null;
}

export async function listVouchers(client: PretixClient, input: { organizer?: string; event: string }) {
  const organizer = client.organizer(input.organizer);
  const result = await client.get<{ count: number; results: PretixVoucher[] }>(
    `/organizers/${organizer}/events/${input.event}/vouchers/`,
  );
  return { count: result.count, vouchers: result.results };
}

export async function getVoucher(
  client: PretixClient,
  input: { organizer?: string; event: string; voucher_id: number },
) {
  const organizer = client.organizer(input.organizer);
  return client.get<PretixVoucher>(
    `/organizers/${organizer}/events/${input.event}/vouchers/${input.voucher_id}/`,
  );
}

export async function createVoucher(
  client: PretixClient,
  input: {
    organizer?: string;
    event: string;
    code?: string;
    max_usages: number;
    value?: string;
    price_mode: "none" | "set" | "subtract" | "percent";
    valid_until?: string;
    item_id?: number;
    tag?: string;
    confirm: boolean;
  },
) {
  const organizer = client.organizer(input.organizer);

  const body = {
    code: input.code,
    max_usages: input.max_usages,
    value: input.value,
    price_mode: input.price_mode,
    valid_until: input.valid_until,
    item: input.item_id,
    tag: input.tag,
  };

  if (!input.confirm) {
    return {
      performed: false,
      message: "Dry run — no voucher created. Re-call with confirm=true to actually create it.",
      would_create: body,
    };
  }

  const created = await client.post<PretixVoucher>(
    `/organizers/${organizer}/events/${input.event}/vouchers/`,
    body,
  );

  return { performed: true, voucher_id: created.id, code: created.code };
}

export async function batchCreateVouchers(
  client: PretixClient,
  input: {
    organizer?: string;
    event: string;
    count: number;
    max_usages: number;
    value?: string;
    price_mode: "none" | "set" | "subtract" | "percent";
    valid_until?: string;
    item_id?: number;
    tag?: string;
    confirm: boolean;
  },
) {
  const organizer = client.organizer(input.organizer);

  const template = {
    max_usages: input.max_usages,
    value: input.value,
    price_mode: input.price_mode,
    valid_until: input.valid_until,
    item: input.item_id,
    tag: input.tag,
  };

  if (!input.confirm) {
    return {
      performed: false,
      message: `Dry run — no vouchers created. Re-call with confirm=true to actually create ${input.count} of them.`,
      would_create: { count: input.count, template },
    };
  }

  const created = await client.post<PretixVoucher[]>(
    `/organizers/${organizer}/events/${input.event}/vouchers/batch_create/`,
    Array.from({ length: input.count }, () => template),
  );

  return {
    performed: true,
    count: created.length,
    codes: created.map((v) => v.code),
  };
}

export async function updateVoucher(
  client: PretixClient,
  input: {
    organizer?: string;
    event: string;
    voucher_id: number;
    max_usages?: number;
    valid_until?: string;
    confirm: boolean;
  },
) {
  const organizer = client.organizer(input.organizer);

  const patch: Record<string, unknown> = {};
  if (input.max_usages !== undefined) patch.max_usages = input.max_usages;
  if (input.valid_until !== undefined) patch.valid_until = input.valid_until;

  if (!input.confirm) {
    return {
      performed: false,
      message: "Dry run — no change made. Re-call with confirm=true to apply this update.",
      would_change: patch,
    };
  }

  const updated = await client.patch<PretixVoucher>(
    `/organizers/${organizer}/events/${input.event}/vouchers/${input.voucher_id}/`,
    patch,
  );

  return { performed: true, voucher_id: updated.id, code: updated.code };
}

export async function deleteVoucher(
  client: PretixClient,
  input: { organizer?: string; event: string; voucher_id: number; confirm: boolean },
) {
  const organizer = client.organizer(input.organizer);
  const voucher = await getVoucher(client, { organizer, event: input.event, voucher_id: input.voucher_id });

  if (!input.confirm) {
    return {
      performed: false,
      message: "Dry run — no voucher deleted. Re-call with confirm=true to actually delete it.",
      would_delete: { id: voucher.id, code: voucher.code },
    };
  }

  await client.delete(`/organizers/${organizer}/events/${input.event}/vouchers/${input.voucher_id}/`);

  return { performed: true, voucher_id: input.voucher_id, code: voucher.code };
}

interface PretixDiscount {
  id: number;
  internal_name: string | null;
}

export async function listDiscounts(client: PretixClient, input: { organizer?: string; event: string }) {
  const organizer = client.organizer(input.organizer);
  const result = await client.get<{ results: PretixDiscount[] }>(
    `/organizers/${organizer}/events/${input.event}/discounts/`,
  );
  return { discounts: result.results };
}

interface PretixGiftCard {
  id: number;
  secret: string;
  value: string;
  currency: string;
  expires: string | null;
}

export async function listGiftCards(client: PretixClient, input: { organizer?: string }) {
  const organizer = client.organizer(input.organizer);
  const result = await client.get<{ count: number; results: PretixGiftCard[] }>(
    `/organizers/${organizer}/giftcards/`,
  );
  return { count: result.count, gift_cards: result.results };
}
