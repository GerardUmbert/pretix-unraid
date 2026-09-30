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
