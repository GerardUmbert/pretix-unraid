import { z } from "zod";
import type { PretixClient } from "../client.js";
import { getAllPages } from "./paging.js";

export const listWebhooksInputSchema = {
  organizer: z.string().optional().describe("Organizer slug. Defaults to PRETIX_ORGANIZER."),
};

export const createWebhookInputSchema = {
  organizer: z.string().optional().describe("Organizer slug. Defaults to PRETIX_ORGANIZER."),
  target_url: z
    .string()
    .describe(
      "URL pretix will POST events to. Note: pretix's webhook payloads have no documented signature/HMAC verification, so the receiving endpoint has no built-in way to confirm the request actually came from pretix — consider a secret path segment or similar convention on your receiver.",
    ),
  enabled: z.boolean().default(true).describe("Whether this webhook is active."),
  all_events: z.boolean().default(true).describe("Whether this applies to all events, or only limit_event_slugs."),
  limit_event_slugs: z
    .array(z.string())
    .optional()
    .describe("Event slugs to limit this webhook to, if all_events is false."),
  action_types: z
    .array(z.string())
    .optional()
    .describe("Action type filters, e.g. ['pretix.event.order.placed', 'pretix.event.order.paid']. Omit for all types."),
  confirm: z
    .boolean()
    .describe("Must be explicitly set to true to actually create the webhook. Call once with confirm=false to preview first."),
};

export const updateWebhookInputSchema = {
  organizer: z.string().optional().describe("Organizer slug. Defaults to PRETIX_ORGANIZER."),
  webhook_id: z.number().int().describe("Webhook ID to update."),
  enabled: z.boolean().optional().describe("New enabled state, if changing."),
  target_url: z.string().optional().describe("New target URL, if changing."),
  confirm: z
    .boolean()
    .describe("Must be explicitly set to true to actually update the webhook. Call once with confirm=false to preview first."),
};

export const deleteWebhookInputSchema = {
  organizer: z.string().optional().describe("Organizer slug. Defaults to PRETIX_ORGANIZER."),
  webhook_id: z.number().int().describe("Webhook ID to delete."),
  confirm: z
    .boolean()
    .describe("Must be explicitly set to true to actually delete the webhook. Call once with confirm=false to preview first."),
};

export const listDevicesInputSchema = {
  organizer: z.string().optional().describe("Organizer slug. Defaults to PRETIX_ORGANIZER."),
};

interface PretixWebhook {
  id: number;
  target_url: string;
  enabled: boolean;
  all_events: boolean;
  limit_events: string[];
  action_types: string[];
}

export async function listWebhooks(client: PretixClient, input: { organizer?: string }) {
  const organizer = client.organizer(input.organizer);
  const result = { results: (await getAllPages<PretixWebhook>(client, `/organizers/${organizer}/webhooks/`)).rows };
  return { webhooks: result.results };
}

export async function createWebhook(
  client: PretixClient,
  input: {
    organizer?: string;
    target_url: string;
    enabled: boolean;
    all_events: boolean;
    limit_event_slugs?: string[];
    action_types?: string[];
    confirm: boolean;
  },
) {
  const organizer = client.organizer(input.organizer);

  const body = {
    target_url: input.target_url,
    enabled: input.enabled,
    all_events: input.all_events,
    limit_events: input.limit_event_slugs ?? [],
    action_types: input.action_types ?? [],
  };

  if (!input.confirm) {
    return {
      performed: false,
      message:
        "Dry run — no webhook created. Re-call with confirm=true to actually create it. Reminder: pretix does not sign webhook payloads, so the receiver can't verify their origin on its own.",
      would_create: body,
    };
  }

  const created = await client.post<PretixWebhook>(`/organizers/${organizer}/webhooks/`, body);
  return { performed: true, webhook_id: created.id, target_url: created.target_url };
}

export async function updateWebhook(
  client: PretixClient,
  input: { organizer?: string; webhook_id: number; enabled?: boolean; target_url?: string; confirm: boolean },
) {
  const organizer = client.organizer(input.organizer);

  const patch: Record<string, unknown> = {};
  if (input.enabled !== undefined) patch.enabled = input.enabled;
  if (input.target_url !== undefined) patch.target_url = input.target_url;

  if (!input.confirm) {
    return {
      performed: false,
      message: "Dry run — no change made. Re-call with confirm=true to apply this update.",
      would_change: patch,
    };
  }

  const updated = await client.patch<PretixWebhook>(
    `/organizers/${organizer}/webhooks/${input.webhook_id}/`,
    patch,
  );

  return { performed: true, webhook_id: updated.id };
}

export async function deleteWebhook(
  client: PretixClient,
  input: { organizer?: string; webhook_id: number; confirm: boolean },
) {
  const organizer = client.organizer(input.organizer);

  if (!input.confirm) {
    return {
      performed: false,
      message: "Dry run — no webhook deleted. Re-call with confirm=true to actually delete it.",
      would_delete: { webhook_id: input.webhook_id },
    };
  }

  await client.delete(`/organizers/${organizer}/webhooks/${input.webhook_id}/`);
  return { performed: true, webhook_id: input.webhook_id };
}

interface PretixDevice {
  device_id: number;
  name: string;
  initialized: string | null;
}

export async function listDevices(client: PretixClient, input: { organizer?: string }) {
  const organizer = client.organizer(input.organizer);
  const result = { results: (await getAllPages<PretixDevice>(client, `/organizers/${organizer}/devices/`)).rows };
  return { devices: result.results };
}
