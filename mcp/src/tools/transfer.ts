import { z } from "zod";
import type { PretixClient } from "../client.js";
import type { PretixOrder, PretixOrderPosition } from "../types.js";

export const transferTicketInputSchema = {
  order_code: z.string().describe("The pretix order code, e.g. 'ABC12'."),
  positionid: z
    .number()
    .int()
    .optional()
    .describe(
      "Which position within the order to transfer (the order's positionid field, 1-based, not the internal id). Required if the order has more than one position — omit only for single-ticket orders.",
    ),
  new_attendee_name: z.string().describe("Name of the person receiving the ticket."),
  new_attendee_email: z.string().optional().describe("Email of the person receiving the ticket."),
  update_order_email: z
    .boolean()
    .default(false)
    .describe(
      "Also change the order's contact email to new_attendee_email, so order emails go to the new holder. Leave false if the original buyer should keep receiving order emails, or if the order has other tickets.",
    ),
  reissue_secret: z
    .boolean()
    .default(true)
    .describe(
      "Invalidate the old QR/secret and issue a new one, so the previous holder's copy stops working. Irreversible. Set false to keep the same QR (the old holder's copy would still scan).",
    ),
  organizer: z.string().optional().describe("Organizer slug. Defaults to PRETIX_ORGANIZER."),
  event: z.string().optional().describe("Event slug. Defaults to PRETIX_EVENT."),
  confirm: z
    .boolean()
    .describe("Must be explicitly set to true to actually transfer the ticket. Call once with confirm=false to preview first."),
};

export async function transferTicket(
  client: PretixClient,
  input: {
    order_code: string;
    positionid?: number;
    new_attendee_name: string;
    new_attendee_email?: string;
    update_order_email: boolean;
    reissue_secret: boolean;
    organizer?: string;
    event?: string;
    confirm: boolean;
  },
) {
  const organizer = client.organizer(input.organizer);
  const event = client.event(input.event);

  if (input.update_order_email && !input.new_attendee_email) {
    throw new Error("update_order_email requires new_attendee_email.");
  }

  const order = await client.get<PretixOrder>(
    `/organizers/${organizer}/events/${event}/orders/${input.order_code}/`,
  );

  const activePositions = order.positions.filter((p) => !p.canceled);
  let target: PretixOrderPosition;

  if (input.positionid !== undefined) {
    const match = activePositions.find((p) => p.positionid === input.positionid);
    if (!match) {
      throw new Error(
        `Order ${order.code} has no active position with positionid ${input.positionid}. Active positions: ${activePositions
          .map((p) => p.positionid)
          .join(", ")}`,
      );
    }
    target = match;
  } else {
    if (activePositions.length !== 1) {
      throw new Error(
        `Order ${order.code} has ${activePositions.length} active positions (${activePositions
          .map((p) => p.positionid)
          .join(", ")}) — pass positionid to specify which one to transfer.`,
      );
    }
    target = activePositions[0];
  }

  const patch: Record<string, unknown> = { attendee_name: input.new_attendee_name };
  if (input.new_attendee_email !== undefined) patch.attendee_email = input.new_attendee_email;

  if (!input.confirm) {
    return {
      performed: false,
      message: "Dry run — no change made. Re-call with confirm=true to transfer this ticket.",
      would_transfer: {
        order_code: order.code,
        positionid: target.positionid,
        from: { attendee_name: target.attendee_name, order_email: order.email },
        to: patch,
        update_order_email: input.update_order_email,
        reissue_secret: input.reissue_secret,
      },
    };
  }

  const base = `/organizers/${organizer}/events/${event}`;
  let updated = await client.patch<PretixOrderPosition>(`${base}/orderpositions/${target.id}/`, patch);

  if (input.update_order_email) {
    await client.patch(`${base}/orders/${order.code}/`, { email: input.new_attendee_email });
  }

  let newSecret = updated.secret;
  if (input.reissue_secret) {
    updated = await client.post<PretixOrderPosition>(`${base}/orderpositions/${target.id}/regenerate_secrets/`);
    newSecret = updated.secret;
  }

  return {
    performed: true,
    order_code: order.code,
    positionid: updated.positionid,
    attendee_name: updated.attendee_name,
    attendee_email: updated.attendee_email,
    order_email_updated: input.update_order_email,
    secret_reissued: input.reissue_secret,
    old_secret: target.secret,
    new_secret: newSecret,
  };
}
