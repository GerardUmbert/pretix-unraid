import { z } from "zod";
import type { PretixClient } from "../client.js";

export const listCustomersInputSchema = {
  organizer: z.string().optional().describe("Organizer slug. Defaults to PRETIX_ORGANIZER."),
  search: z.string().optional().describe("Free-text search, e.g. name or email."),
};

export const getCustomerInputSchema = {
  organizer: z.string().optional().describe("Organizer slug. Defaults to PRETIX_ORGANIZER."),
  customer_id: z.string().describe("Customer identifier."),
};

export const createCustomerInputSchema = {
  organizer: z.string().optional().describe("Organizer slug. Defaults to PRETIX_ORGANIZER."),
  email: z.string().describe("Customer email (also their login)."),
  name: z.string().optional().describe("Customer full name."),
  phone: z.string().optional().describe("Customer phone number."),
  password: z
    .string()
    .optional()
    .describe("Initial password. Omit to create the account without one; the customer can set it via the shop's password reset."),
  send_email: z.boolean().default(false).describe("Whether pretix should email the customer about their new account."),
  confirm: z
    .boolean()
    .describe("Must be explicitly set to true to actually create the customer. Call once with confirm=false to preview first."),
};

export const updateCustomerInputSchema = {
  organizer: z.string().optional().describe("Organizer slug. Defaults to PRETIX_ORGANIZER."),
  customer_id: z.string().describe("Customer identifier."),
  email: z.string().optional().describe("New email, if changing."),
  name: z.string().optional().describe("New full name, if changing."),
  phone: z.string().nullable().optional().describe("New phone number, or null to clear, if changing."),
  is_active: z.boolean().optional().describe("Enable or disable the account, if changing."),
  confirm: z
    .boolean()
    .describe("Must be explicitly set to true to actually update the customer. Call once with confirm=false to preview first."),
};

export const listMembershipsInputSchema = {
  organizer: z.string().optional().describe("Organizer slug. Defaults to PRETIX_ORGANIZER."),
  customer_id: z.string().describe("Customer identifier."),
};

export const listMembershipTypesInputSchema = {
  organizer: z.string().optional().describe("Organizer slug. Defaults to PRETIX_ORGANIZER."),
};

interface PretixCustomer {
  identifier: string;
  email: string | null;
  name: string | null;
  is_verified: boolean;
}

export async function listCustomers(
  client: PretixClient,
  input: { organizer?: string; search?: string },
) {
  const organizer = client.organizer(input.organizer);
  const params = new URLSearchParams();
  if (input.search) params.set("search", input.search);
  const query = params.toString();

  const result = await client.get<{ count: number; results: PretixCustomer[] }>(
    `/organizers/${organizer}/customers/${query ? `?${query}` : ""}`,
  );
  return { count: result.count, customers: result.results };
}

export async function getCustomer(
  client: PretixClient,
  input: { organizer?: string; customer_id: string },
) {
  const organizer = client.organizer(input.organizer);
  return client.get<PretixCustomer>(`/organizers/${organizer}/customers/${input.customer_id}/`);
}

export async function createCustomer(
  client: PretixClient,
  input: {
    organizer?: string;
    email: string;
    name?: string;
    phone?: string;
    password?: string;
    send_email: boolean;
    confirm: boolean;
  },
) {
  const organizer = client.organizer(input.organizer);

  const body: Record<string, unknown> = { email: input.email, send_email: input.send_email };
  if (input.name !== undefined) body.name_parts = { _scheme: "full", full_name: input.name };
  if (input.phone !== undefined) body.phone = input.phone;
  if (input.password !== undefined) body.password = input.password;

  if (!input.confirm) {
    return {
      performed: false,
      message: "Dry run — no customer created. Re-call with confirm=true to actually create it.",
      would_create: { ...body, password: input.password !== undefined ? "(set)" : undefined },
    };
  }

  const created = await client.post<PretixCustomer>(`/organizers/${organizer}/customers/`, body);
  return { performed: true, identifier: created.identifier, email: created.email };
}

export async function updateCustomer(
  client: PretixClient,
  input: {
    organizer?: string;
    customer_id: string;
    email?: string;
    name?: string;
    phone?: string | null;
    is_active?: boolean;
    confirm: boolean;
  },
) {
  const organizer = client.organizer(input.organizer);

  const patch: Record<string, unknown> = {};
  if (input.email !== undefined) patch.email = input.email;
  if (input.name !== undefined) patch.name_parts = { _scheme: "full", full_name: input.name };
  if (input.phone !== undefined) patch.phone = input.phone;
  if (input.is_active !== undefined) patch.is_active = input.is_active;

  if (!input.confirm) {
    return {
      performed: false,
      message: "Dry run — no change made. Re-call with confirm=true to apply this update.",
      would_change: patch,
    };
  }

  const updated = await client.patch<PretixCustomer>(
    `/organizers/${organizer}/customers/${input.customer_id}/`,
    patch,
  );
  return { performed: true, identifier: updated.identifier, email: updated.email };
}

interface PretixMembership {
  id: number;
  membership_type: number;
  date_start: string;
  date_end: string;
  attendee_name: string | null;
}

export async function listMemberships(
  client: PretixClient,
  input: { organizer?: string; customer_id: string },
) {
  const organizer = client.organizer(input.organizer);
  const result = await client.get<{ results: PretixMembership[] }>(
    `/organizers/${organizer}/customers/${input.customer_id}/memberships/`,
  );
  return { memberships: result.results };
}

interface PretixMembershipType {
  id: number;
  name: Record<string, string>;
}

export async function listMembershipTypes(client: PretixClient, input: { organizer?: string }) {
  const organizer = client.organizer(input.organizer);
  const result = await client.get<{ results: PretixMembershipType[] }>(
    `/organizers/${organizer}/membershiptypes/`,
  );
  return {
    membership_types: result.results.map((t) => ({
      id: t.id,
      name: t.name.en ?? Object.values(t.name)[0],
    })),
  };
}
