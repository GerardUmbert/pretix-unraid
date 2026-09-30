import { z } from "zod";
import type { PretixClient } from "../client.js";

export const listEventsInputSchema = {
  organizer: z.string().optional().describe("Organizer slug. Defaults to PRETIX_ORGANIZER."),
};

export const getEventInputSchema = {
  organizer: z.string().optional().describe("Organizer slug. Defaults to PRETIX_ORGANIZER."),
  event: z.string().describe("Event slug."),
};

export const listItemsInputSchema = {
  organizer: z.string().optional().describe("Organizer slug. Defaults to PRETIX_ORGANIZER."),
  event: z.string().describe("Event slug."),
};

export const getItemInputSchema = {
  organizer: z.string().optional().describe("Organizer slug. Defaults to PRETIX_ORGANIZER."),
  event: z.string().describe("Event slug."),
  item_id: z.number().int().describe("Item (product) ID."),
};

export const createItemInputSchema = {
  organizer: z.string().optional().describe("Organizer slug. Defaults to PRETIX_ORGANIZER."),
  event: z.string().describe("Event slug."),
  name: z.string().describe("Item name (English)."),
  default_price: z.string().describe("Default price, e.g. '10.00'."),
  tax_rate: z.string().default("0.00").describe("Tax rate percentage, e.g. '19.00'."),
  category_id: z.number().int().optional().describe("Category ID to place this item under."),
  confirm: z
    .boolean()
    .describe("Must be explicitly set to true to actually create the item. Call once with confirm=false to preview first."),
};

export const updateItemInputSchema = {
  organizer: z.string().optional().describe("Organizer slug. Defaults to PRETIX_ORGANIZER."),
  event: z.string().describe("Event slug."),
  item_id: z.number().int().describe("Item (product) ID to update."),
  name: z.string().optional().describe("New name (English), if changing."),
  default_price: z.string().optional().describe("New default price, if changing."),
  active: z.boolean().optional().describe("Whether the item is active/purchasable, if changing."),
  confirm: z
    .boolean()
    .describe("Must be explicitly set to true to actually update the item. Call once with confirm=false to preview first."),
};

export const listCategoriesInputSchema = {
  organizer: z.string().optional().describe("Organizer slug. Defaults to PRETIX_ORGANIZER."),
  event: z.string().describe("Event slug."),
};

export const createCategoryInputSchema = {
  organizer: z.string().optional().describe("Organizer slug. Defaults to PRETIX_ORGANIZER."),
  event: z.string().describe("Event slug."),
  name: z.string().describe("Category name (English)."),
  confirm: z
    .boolean()
    .describe("Must be explicitly set to true to actually create the category. Call once with confirm=false to preview first."),
};

export const listTaxRulesInputSchema = {
  organizer: z.string().optional().describe("Organizer slug. Defaults to PRETIX_ORGANIZER."),
  event: z.string().describe("Event slug."),
};

export const listQuotasInputSchema = {
  organizer: z.string().optional().describe("Organizer slug. Defaults to PRETIX_ORGANIZER."),
  event: z.string().describe("Event slug."),
};

export const getQuotaAvailabilityInputSchema = {
  organizer: z.string().optional().describe("Organizer slug. Defaults to PRETIX_ORGANIZER."),
  event: z.string().describe("Event slug."),
  quota_id: z.number().int().describe("Quota ID (from pretix_list_quotas)."),
};

export const createQuotaInputSchema = {
  organizer: z.string().optional().describe("Organizer slug. Defaults to PRETIX_ORGANIZER."),
  event: z.string().describe("Event slug."),
  name: z.string().describe("Quota name."),
  size: z.number().int().nullable().describe("Quota capacity, or null for unlimited."),
  item_ids: z.array(z.number().int()).min(1).describe("Item IDs this quota covers."),
  confirm: z
    .boolean()
    .describe("Must be explicitly set to true to actually create the quota. Call once with confirm=false to preview first."),
};

export const updateQuotaInputSchema = {
  organizer: z.string().optional().describe("Organizer slug. Defaults to PRETIX_ORGANIZER."),
  event: z.string().describe("Event slug."),
  quota_id: z.number().int().describe("Quota ID to update."),
  size: z.number().int().nullable().optional().describe("New capacity, or null for unlimited, if changing."),
  closed: z.boolean().optional().describe("Whether the quota is manually closed, if changing."),
  confirm: z
    .boolean()
    .describe("Must be explicitly set to true to actually update the quota. Call once with confirm=false to preview first."),
};

interface PretixEvent {
  slug: string;
  name: Record<string, string>;
  date_from: string;
  date_to: string | null;
  live: boolean;
  testmode: boolean;
  currency: string;
  has_subevents: boolean;
}

export async function listEvents(client: PretixClient, input: { organizer?: string }) {
  const organizer = client.organizer(input.organizer);
  const result = await client.get<{ results: PretixEvent[] }>(`/organizers/${organizer}/events/`);
  return {
    events: result.results.map((e) => ({
      slug: e.slug,
      name: e.name.en ?? Object.values(e.name)[0],
      date_from: e.date_from,
      date_to: e.date_to,
      live: e.live,
      testmode: e.testmode,
      currency: e.currency,
    })),
  };
}

export async function getEvent(client: PretixClient, input: { organizer?: string; event: string }) {
  const organizer = client.organizer(input.organizer);
  return client.get<PretixEvent>(`/organizers/${organizer}/events/${input.event}/`);
}

interface PretixItem {
  id: number;
  name: Record<string, string>;
  active: boolean;
  default_price: string;
  tax_rate: string;
  category: number | null;
}

export async function listItems(client: PretixClient, input: { organizer?: string; event: string }) {
  const organizer = client.organizer(input.organizer);
  const result = await client.get<{ results: PretixItem[] }>(
    `/organizers/${organizer}/events/${input.event}/items/`,
  );
  return {
    items: result.results.map((i) => ({
      id: i.id,
      name: i.name.en ?? Object.values(i.name)[0],
      active: i.active,
      default_price: i.default_price,
      tax_rate: i.tax_rate,
      category: i.category,
    })),
  };
}

export async function getItem(
  client: PretixClient,
  input: { organizer?: string; event: string; item_id: number },
) {
  const organizer = client.organizer(input.organizer);
  return client.get<PretixItem>(`/organizers/${organizer}/events/${input.event}/items/${input.item_id}/`);
}

export async function createItem(
  client: PretixClient,
  input: {
    organizer?: string;
    event: string;
    name: string;
    default_price: string;
    tax_rate: string;
    category_id?: number;
    confirm: boolean;
  },
) {
  const organizer = client.organizer(input.organizer);

  if (!input.confirm) {
    return {
      performed: false,
      message: "Dry run — no item created. Re-call with confirm=true to actually create it.",
      would_create: { name: input.name, default_price: input.default_price, tax_rate: input.tax_rate },
    };
  }

  const created = await client.post<PretixItem>(`/organizers/${organizer}/events/${input.event}/items/`, {
    name: { en: input.name },
    default_price: input.default_price,
    tax_rate: input.tax_rate,
    category: input.category_id ?? null,
  });

  return { performed: true, item_id: created.id, name: input.name };
}

export async function updateItem(
  client: PretixClient,
  input: {
    organizer?: string;
    event: string;
    item_id: number;
    name?: string;
    default_price?: string;
    active?: boolean;
    confirm: boolean;
  },
) {
  const organizer = client.organizer(input.organizer);
  const current = await getItem(client, { organizer, event: input.event, item_id: input.item_id });

  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) patch.name = { en: input.name };
  if (input.default_price !== undefined) patch.default_price = input.default_price;
  if (input.active !== undefined) patch.active = input.active;

  if (!input.confirm) {
    return {
      performed: false,
      message: "Dry run — no change made. Re-call with confirm=true to apply this update.",
      current: { id: current.id, name: current.name.en, default_price: current.default_price, active: current.active },
      would_change: patch,
    };
  }

  const updated = await client.patch<PretixItem>(
    `/organizers/${organizer}/events/${input.event}/items/${input.item_id}/`,
    patch,
  );

  return { performed: true, item_id: updated.id };
}

interface PretixCategory {
  id: number;
  name: Record<string, string>;
}

export async function listCategories(client: PretixClient, input: { organizer?: string; event: string }) {
  const organizer = client.organizer(input.organizer);
  const result = await client.get<{ results: PretixCategory[] }>(
    `/organizers/${organizer}/events/${input.event}/categories/`,
  );
  return { categories: result.results.map((c) => ({ id: c.id, name: c.name.en ?? Object.values(c.name)[0] })) };
}

export async function createCategory(
  client: PretixClient,
  input: { organizer?: string; event: string; name: string; confirm: boolean },
) {
  const organizer = client.organizer(input.organizer);

  if (!input.confirm) {
    return {
      performed: false,
      message: "Dry run — no category created. Re-call with confirm=true to actually create it.",
      would_create: { name: input.name },
    };
  }

  const created = await client.post<PretixCategory>(
    `/organizers/${organizer}/events/${input.event}/categories/`,
    { name: { en: input.name } },
  );

  return { performed: true, category_id: created.id, name: input.name };
}

interface PretixTaxRule {
  id: number;
  name: string;
  rate: string;
}

export async function listTaxRules(client: PretixClient, input: { organizer?: string; event: string }) {
  const organizer = client.organizer(input.organizer);
  const result = await client.get<{ results: PretixTaxRule[] }>(
    `/organizers/${organizer}/events/${input.event}/taxrules/`,
  );
  return { tax_rules: result.results };
}

interface PretixQuota {
  id: number;
  name: string;
  size: number | null;
  items: number[];
  closed: boolean;
}

export async function listQuotas(client: PretixClient, input: { organizer?: string; event: string }) {
  const organizer = client.organizer(input.organizer);
  const result = await client.get<{ results: PretixQuota[] }>(
    `/organizers/${organizer}/events/${input.event}/quotas/`,
  );
  return { quotas: result.results };
}

interface PretixQuotaAvailability {
  available: boolean;
  available_number: number | null;
  total_size: number | null;
  pending_orders: number;
  paid_orders: number;
  cart_positions: number;
  blocking_vouchers: number;
  waiting_list: number;
}

export async function getQuotaAvailability(
  client: PretixClient,
  input: { organizer?: string; event: string; quota_id: number },
) {
  const organizer = client.organizer(input.organizer);
  return client.get<PretixQuotaAvailability>(
    `/organizers/${organizer}/events/${input.event}/quotas/${input.quota_id}/availability/`,
  );
}

export async function createQuota(
  client: PretixClient,
  input: { organizer?: string; event: string; name: string; size: number | null; item_ids: number[]; confirm: boolean },
) {
  const organizer = client.organizer(input.organizer);

  if (!input.confirm) {
    return {
      performed: false,
      message: "Dry run — no quota created. Re-call with confirm=true to actually create it.",
      would_create: { name: input.name, size: input.size, item_ids: input.item_ids },
    };
  }

  const created = await client.post<PretixQuota>(`/organizers/${organizer}/events/${input.event}/quotas/`, {
    name: input.name,
    size: input.size,
    items: input.item_ids,
  });

  return { performed: true, quota_id: created.id, name: input.name };
}

export async function updateQuota(
  client: PretixClient,
  input: { organizer?: string; event: string; quota_id: number; size?: number | null; closed?: boolean; confirm: boolean },
) {
  const organizer = client.organizer(input.organizer);

  const patch: Record<string, unknown> = {};
  if (input.size !== undefined) patch.size = input.size;
  if (input.closed !== undefined) patch.closed = input.closed;

  if (!input.confirm) {
    return {
      performed: false,
      message: "Dry run — no change made. Re-call with confirm=true to apply this update.",
      would_change: patch,
    };
  }

  const updated = await client.patch<PretixQuota>(
    `/organizers/${organizer}/events/${input.event}/quotas/${input.quota_id}/`,
    patch,
  );

  return { performed: true, quota_id: updated.id };
}
