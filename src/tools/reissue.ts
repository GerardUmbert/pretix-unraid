import { z } from "zod";
import type { PretixClient } from "../client.js";
import type { PretixOrder, PretixOrderPosition } from "../types.js";

export const reissueTicketInputSchema = {
  order_code: z.string().describe("The pretix order code, e.g. 'ABC12'."),
  positionid: z
    .number()
    .int()
    .optional()
    .describe(
      "Which position within the order to reissue (the order's positionid field, 1-based, not the internal id). Required if the order has more than one position — omit only for single-ticket orders.",
    ),
  organizer: z.string().optional().describe("Organizer slug. Defaults to PRETIX_ORGANIZER."),
  event: z.string().optional().describe("Event slug. Defaults to PRETIX_EVENT."),
  confirm: z
    .boolean()
    .describe(
      "Must be explicitly set to true to actually perform the reissue. This is irreversible: the old ticket secret stops working immediately with no undo. Call this tool once with confirm=false (or inspect the order first via pretix_get_ticket_status) to see which position would be affected before setting confirm=true.",
    ),
};

export async function reissueTicket(
  client: PretixClient,
  input: {
    order_code: string;
    positionid?: number;
    organizer?: string;
    event?: string;
    confirm: boolean;
  },
) {
  const organizer = client.organizer(input.organizer);
  const event = client.event(input.event);

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
          .join(", ")}) — pass positionid to specify which one to reissue.`,
      );
    }
    target = activePositions[0];
  }

  const preview = {
    order_code: order.code,
    positionid: target.positionid,
    attendee_name: target.attendee_name,
    old_secret: target.secret,
    email: order.email,
  };

  if (!input.confirm) {
    return {
      performed: false,
      message:
        "Dry run — no change made. Re-call this tool with confirm=true to actually reissue this ticket. This action is irreversible once performed.",
      would_reissue: preview,
    };
  }

  const updated = await client.post<PretixOrderPosition>(
    `/organizers/${organizer}/events/${event}/orderpositions/${target.id}/regenerate_secrets/`,
  );

  return {
    performed: true,
    order_code: order.code,
    positionid: updated.positionid,
    attendee_name: updated.attendee_name,
    old_secret: target.secret,
    new_secret: updated.secret,
    message:
      "The old ticket secret is now invalid and will fail check-in. The new secret is valid and tied to the same order, position, and customer. Check-in history was preserved.",
  };
}
