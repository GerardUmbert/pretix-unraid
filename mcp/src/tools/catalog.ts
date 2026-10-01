import { z } from "zod";
import type { PretixClient } from "../client.js";
import { getAllPages } from "./paging.js";

const organizerField = z.string().optional().describe("Organizer slug. Defaults to PRETIX_ORGANIZER.");
const eventField = z.string().describe("Event slug.");

function confirmField(what: string) {
  return z
    .boolean()
    .describe(`Must be explicitly set to true to actually ${what}. Call once with confirm=false to preview first.`);
}

function label(names: Record<string, string> | string | null | undefined): string {
  if (!names) return "";
  if (typeof names === "string") return names;
  return names.en ?? Object.values(names)[0] ?? "";
}

// ---------------------------------------------------------------- variations

export const listVariationsInputSchema = {
  organizer: organizerField,
  event: eventField,
  item_id: z.number().int().describe("Item (product) ID."),
};

export const createVariationInputSchema = {
  organizer: organizerField,
  event: eventField,
  item_id: z.number().int().describe("Item (product) ID. It is switched to has_variations if it was not already."),
  name: z.string().describe("Variation name (English), e.g. 'Table A'."),
  price: z.string().optional().describe("Variation price. Omit to use the item's default price."),
  confirm: confirmField("create the variation"),
};

export const updateVariationInputSchema = {
  organizer: organizerField,
  event: eventField,
  item_id: z.number().int().describe("Item (product) ID."),
  variation_id: z.number().int().describe("Variation ID."),
  name: z.string().optional().describe("New name (English), if changing."),
  price: z.string().nullable().optional().describe("New price, or null to use the item default, if changing."),
  active: z.boolean().optional().describe("Whether the variation is purchasable, if changing."),
  confirm: confirmField("update the variation"),
};

interface PretixVariation {
  id: number;
  value: Record<string, string>;
  default_price: string | null;
  price: string;
  active: boolean;
  position: number;
}

function variationView(v: PretixVariation) {
  return { id: v.id, name: label(v.value), price: v.default_price ?? v.price, active: v.active };
}

export async function listVariations(
  client: PretixClient,
  input: { organizer?: string; event: string; item_id: number },
) {
  const organizer = client.organizer(input.organizer);
  const result = { results: (await getAllPages<PretixVariation>(client, `/organizers/${organizer}/events/${input.event}/items/${input.item_id}/variations/`)).rows };
  return { variations: result.results.map(variationView) };
}

export async function createVariation(
  client: PretixClient,
  input: { organizer?: string; event: string; item_id: number; name: string; price?: string; confirm: boolean },
) {
  const organizer = client.organizer(input.organizer);
  const itemPath = `/organizers/${organizer}/events/${input.event}/items/${input.item_id}/`;

  const body = { value: { en: input.name }, default_price: input.price ?? null, active: true };

  if (!input.confirm) {
    return {
      performed: false,
      message: "Dry run — no variation created. Re-call with confirm=true to actually create it.",
      would_create: { item_id: input.item_id, ...body },
    };
  }

  const item = await client.get<{ has_variations: boolean }>(itemPath);
  if (!item.has_variations) {
    await client.patch(itemPath, { has_variations: true });
  }
  const created = await client.post<PretixVariation>(`${itemPath}variations/`, body);
  return { performed: true, variation: variationView(created) };
}

export async function updateVariation(
  client: PretixClient,
  input: {
    organizer?: string;
    event: string;
    item_id: number;
    variation_id: number;
    name?: string;
    price?: string | null;
    active?: boolean;
    confirm: boolean;
  },
) {
  const organizer = client.organizer(input.organizer);
  const path = `/organizers/${organizer}/events/${input.event}/items/${input.item_id}/variations/${input.variation_id}/`;

  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) patch.value = { en: input.name };
  if (input.price !== undefined) patch.default_price = input.price;
  if (input.active !== undefined) patch.active = input.active;

  if (!input.confirm) {
    return {
      performed: false,
      message: "Dry run — no change made. Re-call with confirm=true to apply this update.",
      would_change: patch,
    };
  }

  const updated = await client.patch<PretixVariation>(path, patch);
  return { performed: true, variation: variationView(updated) };
}

// ----------------------------------------------------------------- questions

const QUESTION_TYPES = ["S", "T", "N", "C", "M", "B", "D", "H", "W", "F"] as const;

export const listQuestionsInputSchema = {
  organizer: organizerField,
  event: eventField,
};

export const createQuestionInputSchema = {
  organizer: organizerField,
  event: eventField,
  question: z.string().describe("The question text shown to the buyer/staff (English), e.g. 'Dietary restrictions'."),
  type: z
    .enum(QUESTION_TYPES)
    .default("S")
    .describe(
      "Answer type: S=short text, T=long text, N=number, C=choice (one option), M=multiple choice, B=yes/no, D=date, H=time, W=date+time, F=file upload.",
    ),
  required: z.boolean().default(false).describe("Whether an answer is mandatory when ordering."),
  item_ids: z
    .array(z.number().int())
    .min(1)
    .describe("Items (ticket types) this question is asked for. It is asked per ticket."),
  options: z
    .array(z.string())
    .optional()
    .describe("Answer options for choice (C) or multiple-choice (M) questions, e.g. ['Vegetarian','Vegan','Gluten-free']."),
  help_text: z.string().optional().describe("Explanatory text shown under the question."),
  identifier: z
    .string()
    .optional()
    .describe("Stable machine-readable identifier (letters, digits, dashes). Handy for your own app; pretix generates one if omitted."),
  ask_during_checkin: z
    .boolean()
    .default(false)
    .describe("Ask for this answer at the door instead of at ordering."),
  show_during_checkin: z
    .boolean()
    .default(true)
    .describe("Show the answer to staff in the check-in app (so dietary or accessibility notes are visible at the door)."),
  confirm: confirmField("create the question"),
};

export const updateQuestionInputSchema = {
  organizer: organizerField,
  event: eventField,
  question_id: z.number().int().describe("Question ID (from pretix_list_questions)."),
  question: z.string().optional().describe("New question text (English), if changing."),
  required: z.boolean().optional().describe("Whether an answer is mandatory, if changing."),
  item_ids: z.array(z.number().int()).optional().describe("Replace the set of items the question applies to, if changing."),
  help_text: z.string().optional().describe("New help text, if changing."),
  show_during_checkin: z.boolean().optional().describe("Whether staff see the answer at check-in, if changing."),
  confirm: confirmField("update the question"),
};

interface PretixQuestion {
  id: number;
  question: Record<string, string>;
  type: string;
  required: boolean;
  items: number[];
  identifier: string;
  ask_during_checkin: boolean;
  show_during_checkin?: boolean;
  options: Array<{ id: number; identifier: string; answer: Record<string, string> }>;
}

function questionView(q: PretixQuestion) {
  return {
    id: q.id,
    question: label(q.question),
    type: q.type,
    required: q.required,
    item_ids: q.items,
    identifier: q.identifier,
    ask_during_checkin: q.ask_during_checkin,
    show_during_checkin: q.show_during_checkin,
    options: q.options.map((o) => ({ id: o.id, identifier: o.identifier, answer: label(o.answer) })),
  };
}

export async function listQuestions(client: PretixClient, input: { organizer?: string; event: string }) {
  const organizer = client.organizer(input.organizer);
  const result = { results: (await getAllPages<PretixQuestion>(client, `/organizers/${organizer}/events/${input.event}/questions/`)).rows };
  return { questions: result.results.map(questionView) };
}

export async function createQuestion(
  client: PretixClient,
  input: {
    organizer?: string;
    event: string;
    question: string;
    type: (typeof QUESTION_TYPES)[number];
    required: boolean;
    item_ids: number[];
    options?: string[];
    help_text?: string;
    identifier?: string;
    ask_during_checkin: boolean;
    show_during_checkin: boolean;
    confirm: boolean;
  },
) {
  const organizer = client.organizer(input.organizer);

  const isChoice = input.type === "C" || input.type === "M";
  if (isChoice && (input.options?.length ?? 0) === 0) {
    throw new Error("Choice (C) and multiple-choice (M) questions need at least one option.");
  }

  const body = {
    question: { en: input.question },
    type: input.type,
    required: input.required,
    items: input.item_ids,
    ask_during_checkin: input.ask_during_checkin,
    show_during_checkin: input.show_during_checkin,
    ...(input.help_text ? { help_text: { en: input.help_text } } : {}),
    ...(input.identifier ? { identifier: input.identifier } : {}),
    ...(isChoice ? { options: input.options!.map((a, i) => ({
            answer: { en: a },
            position: i,
            identifier: a.toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "") || `OPT${i + 1}`,
          })) } : {}),
  };

  if (!input.confirm) {
    return {
      performed: false,
      message: "Dry run — no question created. Re-call with confirm=true to actually create it.",
      would_create: body,
    };
  }

  const created = await client.post<PretixQuestion>(`/organizers/${organizer}/events/${input.event}/questions/`, body);
  return { performed: true, question: questionView(created) };
}

export async function updateQuestion(
  client: PretixClient,
  input: {
    organizer?: string;
    event: string;
    question_id: number;
    question?: string;
    required?: boolean;
    item_ids?: number[];
    help_text?: string;
    show_during_checkin?: boolean;
    confirm: boolean;
  },
) {
  const organizer = client.organizer(input.organizer);

  const patch: Record<string, unknown> = {};
  if (input.question !== undefined) patch.question = { en: input.question };
  if (input.required !== undefined) patch.required = input.required;
  if (input.item_ids !== undefined) patch.items = input.item_ids;
  if (input.help_text !== undefined) patch.help_text = { en: input.help_text };
  if (input.show_during_checkin !== undefined) patch.show_during_checkin = input.show_during_checkin;

  if (!input.confirm) {
    return {
      performed: false,
      message: "Dry run — no change made. Re-call with confirm=true to apply this update.",
      would_change: patch,
    };
  }

  const updated = await client.patch<PretixQuestion>(
    `/organizers/${organizer}/events/${input.event}/questions/${input.question_id}/`,
    patch,
  );
  return { performed: true, question: questionView(updated) };
}

// ------------------------------------------------------------------- seating

export const listSeatingPlansInputSchema = { organizer: organizerField };

const seatingCategoryField = z.object({
  name: z.string().describe("Seat category name, e.g. 'VIP'. Mapped to an item afterwards."),
  color: z.string().default("#4a90d9").describe("CSS colour used in the plan designer."),
});

export const createSeatingPlanInputSchema = {
  organizer: organizerField,
  name: z.string().describe("Seating plan name."),
  layout: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "Full pretix seating-plan JSON (categories / zones / rows / seats). Provide this OR grid, not both.",
    ),
  grid: z
    .object({
      categories: z.array(seatingCategoryField).min(1),
      rows: z
        .array(
          z.object({
            label: z.string().describe("Row label, e.g. 'A' or 'Table 1'."),
            seats: z.number().int().min(1).max(200).describe("Number of seats in this row / at this table."),
            category: z.string().describe("Category name for the seats of this row."),
          }),
        )
        .min(1)
        .describe("One entry per row or table, in order."),
      zone_name: z.string().default("Main").describe("Name of the single zone the rows are placed in."),
    })
    .optional()
    .describe("Shortcut: generate a simple plan from rows/tables instead of writing the JSON layout by hand."),
  confirm: confirmField("create the seating plan"),
};

export const setEventSeatingPlanInputSchema = {
  organizer: organizerField,
  event: eventField,
  seating_plan_id: z.number().int().nullable().describe("Seating plan ID to attach, or null to detach."),
  category_item_map: z
    .record(z.string(), z.number().int())
    .optional()
    .describe("Map of seat-category name to item ID, e.g. {'VIP': 12}. Seats can only be sold through their mapped item."),
  confirm: confirmField("change the event's seating plan"),
};

export const listSeatsInputSchema = {
  organizer: organizerField,
  event: eventField,
  available_only: z.boolean().default(false).describe("Only return seats that can still be sold."),
};

function buildGridLayout(name: string, grid: NonNullable<z.infer<z.ZodObject<typeof createSeatingPlanInputSchema>>["grid"]>) {
  const SPACING = 30;
  const ROW_GAP = 50;
  let maxWidth = 0;
  const rows = grid.rows.map((r, ri) => {
    maxWidth = Math.max(maxWidth, r.seats * SPACING);
    return {
      row_number: r.label,
      position: { x: 0, y: ri * ROW_GAP },
      seats: Array.from({ length: r.seats }, (_, si) => ({
        seat_number: String(si + 1),
        seat_guid: `${r.label}-${si + 1}`.replace(/\s+/g, "_"),
        position: { x: si * SPACING, y: 0 },
        category: r.category,
      })),
    };
  });
  return {
    name,
    categories: grid.categories.map((c) => ({ name: c.name, color: c.color })),
    zones: [
      {
        name: grid.zone_name,
        position: { x: 0, y: 0 },
        rows,
      },
    ],
    size: { width: Math.max(maxWidth + 40, 200), height: rows.length * ROW_GAP + 40 },
  };
}

interface PretixSeatingPlan {
  id: number;
  name: string;
}

export async function listSeatingPlans(client: PretixClient, input: { organizer?: string }) {
  const organizer = client.organizer(input.organizer);
  const result = { results: (await getAllPages<PretixSeatingPlan>(client, `/organizers/${organizer}/seatingplans/`)).rows };
  return { seating_plans: result.results.map((p) => ({ id: p.id, name: p.name })) };
}

export async function createSeatingPlan(
  client: PretixClient,
  input: {
    organizer?: string;
    name: string;
    layout?: Record<string, unknown>;
    grid?: Parameters<typeof buildGridLayout>[1];
    confirm: boolean;
  },
) {
  const organizer = client.organizer(input.organizer);

  if (!input.layout === !input.grid) {
    throw new Error("Provide exactly one of layout or grid.");
  }
  const layout = input.layout ?? buildGridLayout(input.name, input.grid!);

  const summary = {
    name: input.name,
    seat_count: countSeats(layout),
    categories: (layout.categories as Array<{ name: string }> | undefined)?.map((c) => c.name) ?? [],
  };

  if (!input.confirm) {
    return {
      performed: false,
      message: "Dry run — no seating plan created. Re-call with confirm=true to actually create it.",
      would_create: summary,
    };
  }

  const created = await client.post<PretixSeatingPlan>(`/organizers/${organizer}/seatingplans/`, {
    name: input.name,
    layout,
  });
  return { performed: true, seating_plan_id: created.id, ...summary };
}

function countSeats(layout: Record<string, unknown>): number {
  const zones = (layout.zones as Array<{ rows?: Array<{ seats?: unknown[] }> }> | undefined) ?? [];
  return zones.reduce((n, z) => n + (z.rows ?? []).reduce((m, r) => m + (r.seats?.length ?? 0), 0), 0);
}

export async function setEventSeatingPlan(
  client: PretixClient,
  input: {
    organizer?: string;
    event: string;
    seating_plan_id: number | null;
    category_item_map?: Record<string, number>;
    confirm: boolean;
  },
) {
  const organizer = client.organizer(input.organizer);

  const patch: Record<string, unknown> = { seating_plan: input.seating_plan_id };
  if (input.category_item_map) patch.seat_category_mapping = input.category_item_map;

  if (!input.confirm) {
    return {
      performed: false,
      message: "Dry run — no change made. Re-call with confirm=true to apply.",
      would_change: patch,
    };
  }

  const updated = await client.patch<{ seating_plan: number | null }>(
    `/organizers/${organizer}/events/${input.event}/`,
    patch,
  );
  return {
    performed: true,
    seating_plan_id: updated.seating_plan,
    category_item_map: input.category_item_map ?? null,
  };
}

interface PretixSeat {
  id: number;
  zone_name: string;
  row_name: string;
  seat_number: string;
  seat_guid: string;
  product: number | null;
  blocked: boolean;
  orderposition: number | null;
}

export async function listSeats(
  client: PretixClient,
  input: { organizer?: string; event: string; available_only: boolean },
) {
  const organizer = client.organizer(input.organizer);
  const { rows: seats, complete } = await getAllPages<PretixSeat>(
    client,
    `/organizers/${organizer}/events/${input.event}/seats/${input.available_only ? "?is_available=true" : ""}`,
  );
  return {
    count: seats.length,
    ...(complete ? {} : { complete: false }),
    seats: seats.map((s) => ({
      seat_guid: s.seat_guid,
      zone: s.zone_name,
      row: s.row_name,
      seat: s.seat_number,
      item_id: s.product,
      blocked: s.blocked,
      taken: s.orderposition !== null,
    })),
  };
}

// ------------------------------------------------------ item meta properties

export const listItemMetaPropertiesInputSchema = { organizer: organizerField, event: eventField };

export const createItemMetaPropertyInputSchema = {
  organizer: organizerField,
  event: eventField,
  name: z.string().describe("Property key, e.g. 'app_id'. Items can then carry meta_data for this key."),
  default: z.string().optional().describe("Default value for items that do not set one."),
  required: z.boolean().default(false).describe("Whether every item must set a value."),
  allowed_values: z.array(z.string()).optional().describe("Restrict values to this list, if given."),
  confirm: confirmField("create the item meta property"),
};

interface PretixItemMetaProperty {
  id: number;
  name: string;
  default: string;
  required: boolean;
  allowed_values: string[] | null;
}

export async function listItemMetaProperties(client: PretixClient, input: { organizer?: string; event: string }) {
  const organizer = client.organizer(input.organizer);
  const result = { results: (await getAllPages<PretixItemMetaProperty>(client, `/organizers/${organizer}/events/${input.event}/item_meta_properties/`)).rows };
  return { properties: result.results };
}

export async function createItemMetaProperty(
  client: PretixClient,
  input: {
    organizer?: string;
    event: string;
    name: string;
    default?: string;
    required: boolean;
    allowed_values?: string[];
    confirm: boolean;
  },
) {
  const organizer = client.organizer(input.organizer);
  const body = {
    name: input.name,
    default: input.default ?? "",
    required: input.required,
    allowed_values: input.allowed_values ?? null,
  };

  if (!input.confirm) {
    return {
      performed: false,
      message: "Dry run — no property created. Re-call with confirm=true to actually create it.",
      would_create: body,
    };
  }

  const created = await client.post<PretixItemMetaProperty>(`/organizers/${organizer}/events/${input.event}/item_meta_properties/`, body);
  return { performed: true, property: created };
}
