import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { PretixClient, loadConfigFromEnv, PretixApiError } from "./client.js";
import { ticketStatusInputSchema, getTicketStatus } from "./tools/ticket-status.js";
import { reissueTicketInputSchema, reissueTicket } from "./tools/reissue.js";
import {
  markOrderPaidInputSchema,
  cancelOrderInputSchema,
  markOrderPaid,
  cancelOrder,
} from "./tools/orders.js";

const config = loadConfigFromEnv();
const client = new PretixClient(config);

const server = new McpServer({ name: "pretix-mcp", version: "0.1.0" });

function asToolResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function asErrorResult(err: unknown) {
  if (err instanceof PretixApiError) {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: `pretix API returned ${err.status}: ${JSON.stringify(err.body)}`,
        },
      ],
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

server.registerTool(
  "pretix_get_ticket_status",
  {
    description:
      "Look up a pretix order by its order code and return its current status plus a chronological history synthesized from payments, refunds, and check-ins. pretix has no dedicated order-history endpoint, so this tool builds the timeline itself from the order's nested data.",
    inputSchema: ticketStatusInputSchema,
  },
  async (input) => {
    try {
      return asToolResult(await getTicketStatus(client, input));
    } catch (err) {
      return asErrorResult(err);
    }
  },
);

server.registerTool(
  "pretix_reissue_ticket",
  {
    description:
      "Invalidate a ticket's current secret/QR code and issue a new one, keeping the same order, position, and customer, and preserving check-in history. This is irreversible: the old code stops working immediately. Call with confirm=false first to preview which position would be affected.",
    inputSchema: reissueTicketInputSchema,
  },
  async (input) => {
    try {
      return asToolResult(await reissueTicket(client, input));
    } catch (err) {
      return asErrorResult(err);
    }
  },
);

server.registerTool(
  "pretix_mark_order_paid",
  {
    description:
      "Mark a pretix order as paid. Call with confirm=false first to preview the order's current status.",
    inputSchema: markOrderPaidInputSchema,
  },
  async (input) => {
    try {
      return asToolResult(await markOrderPaid(client, input));
    } catch (err) {
      return asErrorResult(err);
    }
  },
);

server.registerTool(
  "pretix_cancel_order",
  {
    description:
      "Cancel a pretix order. Call with confirm=false first to preview the order's current status.",
    inputSchema: cancelOrderInputSchema,
  },
  async (input) => {
    try {
      return asToolResult(await cancelOrder(client, input));
    } catch (err) {
      return asErrorResult(err);
    }
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal error starting pretix-mcp:", err);
  process.exit(1);
});
