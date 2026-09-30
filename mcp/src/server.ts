import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PretixClient, PretixApiError, type PretixConfig } from "./client.js";
import { ticketStatusInputSchema, getTicketStatus } from "./tools/ticket-status.js";
import { reissueTicketInputSchema, reissueTicket } from "./tools/reissue.js";
import { transferTicketInputSchema, transferTicket } from "./tools/transfer.js";
import * as orders from "./tools/orders.js";
import * as checkin from "./tools/checkin.js";
import * as core from "./tools/core.js";
import * as catalog from "./tools/catalog.js";
import * as sales from "./tools/sales.js";
import * as crm from "./tools/crm.js";
import * as admin from "./tools/admin.js";

export type ToolGroup = "orders" | "checkin" | "core" | "sales" | "crm" | "admin";

export const ALL_TOOL_GROUPS: ToolGroup[] = ["orders", "checkin", "core", "sales", "crm", "admin"];

/**
 * Reads PRETIX_TOOL_GROUPS (comma-separated) from env. Defaults to every
 * group when unset or when it contains no valid group name.
 */
export function loadToolGroupsFromEnv(): Set<ToolGroup> {
  const raw = process.env.PRETIX_TOOL_GROUPS;
  if (!raw) return new Set(ALL_TOOL_GROUPS);
  const groups = raw
    .split(",")
    .map((g) => g.trim())
    .filter((g): g is ToolGroup => ALL_TOOL_GROUPS.includes(g as ToolGroup));
  return new Set(groups.length > 0 ? groups : ALL_TOOL_GROUPS);
}

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

/** Wraps a tool implementation so every registered tool has uniform result/error handling. */
function wrap<TInput>(fn: (client: PretixClient, input: TInput) => Promise<unknown>, client: PretixClient) {
  return async (input: TInput) => {
    try {
      return asToolResult(await fn(client, input));
    } catch (err) {
      return asErrorResult(err);
    }
  };
}

/**
 * Builds a fresh McpServer with tools registered against the given
 * config, filtered to the given set of tool groups. Used by both the
 * stdio entrypoint (one process per client) and the HTTP entrypoint
 * (one server instance shared across requests).
 */
export function createServer(config: PretixConfig, enabledGroups: Set<ToolGroup> = new Set(ALL_TOOL_GROUPS)): McpServer {
  const client = new PretixClient(config);
  const server = new McpServer({ name: "pretix-mcp", version: "0.2.0" });

  // These two tools predate tool-group filtering and are always on -
  // they're the original verified core of this server (ticket lookup +
  // reissue) and conceptually belong to "orders"/"checkin" but were
  // built before those groups existed as a concept, so they're kept
  // unconditional rather than retrofitted into the filtering below.
  server.registerTool(
    "pretix_get_ticket_status",
    {
      description:
        "Look up a pretix order by its order code and return its current status plus a chronological history synthesized from payments, refunds, and check-ins. pretix has no dedicated order-history endpoint, so this tool builds the timeline itself from the order's nested data.",
      inputSchema: ticketStatusInputSchema,
    },
    wrap(getTicketStatus, client),
  );

  server.registerTool(
    "pretix_reissue_ticket",
    {
      description:
        "Invalidate a ticket's current secret/QR code and issue a new one, keeping the same order, position, and customer, and preserving check-in history. This is irreversible: the old code stops working immediately. Call with confirm=false first to preview which position would be affected.",
      inputSchema: reissueTicketInputSchema,
    },
    wrap(reissueTicket, client),
  );

  if (enabledGroups.has("orders")) {
    server.registerTool(
      "pretix_list_orders",
      { description: "List orders for an event, optionally filtered by status, email, or free-text search.", inputSchema: orders.listOrdersInputSchema },
      wrap(orders.listOrders, client),
    );
    server.registerTool(
      "pretix_create_order",
      { description: "Create a new order with one or more ticket positions. Supports custom order codes and ticket secrets, useful for syncing tickets an external system already generated. Call with confirm=false first to preview.", inputSchema: orders.createOrderInputSchema },
      wrap(orders.createOrder, client),
    );
    server.registerTool(
      "pretix_transfer_ticket",
      { description: "Transfer a ticket to a different person: change the attendee name/email on one ticket, optionally the order's contact email, and by default reissue the QR so the previous holder's copy stops working. No customer account is needed. Call with confirm=false first to preview.", inputSchema: transferTicketInputSchema },
      wrap(transferTicket, client),
    );
    server.registerTool(
      "pretix_mark_order_paid",
      { description: "Mark a pretix order as paid. Call with confirm=false first to preview.", inputSchema: orders.markOrderPaidInputSchema },
      wrap(orders.markOrderPaid, client),
    );
    server.registerTool(
      "pretix_mark_order_pending",
      { description: "Mark a pretix order as pending. Call with confirm=false first to preview.", inputSchema: orders.markOrderPendingInputSchema },
      wrap(orders.markOrderPending, client),
    );
    server.registerTool(
      "pretix_mark_order_expired",
      { description: "Mark a pretix order as expired. Call with confirm=false first to preview.", inputSchema: orders.markOrderExpiredInputSchema },
      wrap(orders.markOrderExpired, client),
    );
    server.registerTool(
      "pretix_cancel_order",
      { description: "Cancel a pretix order. Call with confirm=false first to preview.", inputSchema: orders.cancelOrderInputSchema },
      wrap(orders.cancelOrder, client),
    );
    server.registerTool(
      "pretix_reactivate_order",
      { description: "Reactivate a canceled order back to pending/paid, if stock allows. Call with confirm=false first to preview.", inputSchema: orders.reactivateOrderInputSchema },
      wrap(orders.reactivateOrder, client),
    );
    server.registerTool(
      "pretix_extend_order",
      { description: "Extend an order's payment deadline. Call with confirm=false first to preview.", inputSchema: orders.extendOrderInputSchema },
      wrap(orders.extendOrder, client),
    );
    server.registerTool(
      "pretix_approve_order",
      { description: "Approve an order that required approval before payment. Call with confirm=false first to preview.", inputSchema: orders.approveOrderInputSchema },
      wrap(orders.approveOrder, client),
    );
    server.registerTool(
      "pretix_deny_order",
      { description: "Deny an order that required approval before payment. Call with confirm=false first to preview.", inputSchema: orders.denyOrderInputSchema },
      wrap(orders.denyOrder, client),
    );
    server.registerTool(
      "pretix_download_ticket",
      { description: "Check whether a ticket file (e.g. PDF) is ready for download and return it if so.", inputSchema: orders.downloadTicketInputSchema },
      wrap(orders.downloadTicket, client),
    );
    server.registerTool(
      "pretix_list_refunds",
      { description: "List refunds for an order.", inputSchema: orders.listRefundsInputSchema },
      wrap(orders.listRefunds, client),
    );
    server.registerTool(
      "pretix_issue_refund",
      { description: "Issue a manual refund on an order. This tool validates the amount against what's actually owed before proceeding, since pretix's own API does not. Call with confirm=false first to preview.", inputSchema: orders.issueRefundInputSchema },
      wrap(orders.issueRefund, client),
    );
  }

  if (enabledGroups.has("checkin")) {
    server.registerTool(
      "pretix_list_checkin_lists",
      { description: "List check-in lists for an event.", inputSchema: checkin.listCheckinListsInputSchema },
      wrap(checkin.listCheckinLists, client),
    );
    server.registerTool(
      "pretix_create_checkin_list",
      { description: "Create a check-in list for an event. Call with confirm=false first to preview.", inputSchema: checkin.createCheckinListInputSchema },
      wrap(checkin.createCheckinList, client),
    );
    server.registerTool(
      "pretix_get_checkin_status",
      { description: "Get check-in counts (checked in, total, currently inside) for a check-in list.", inputSchema: checkin.getCheckinStatusInputSchema },
      wrap(checkin.getCheckinStatus, client),
    );
    server.registerTool(
      "pretix_list_checkin_positions",
      { description: "List/search order positions on a check-in list, e.g. to find an attendee by name.", inputSchema: checkin.listCheckinPositionsInputSchema },
      wrap(checkin.listCheckinPositions, client),
    );
    server.registerTool(
      "pretix_checkin_by_secret",
      { description: "Check in (or check out) a ticket by its scanned secret/QR value against one or more check-in lists.", inputSchema: checkin.checkinBySecretInputSchema },
      wrap(checkin.checkinBySecret, client),
    );
  }

  if (enabledGroups.has("core")) {
    server.registerTool(
      "pretix_list_events",
      { description: "List events for an organizer.", inputSchema: core.listEventsInputSchema },
      wrap(core.listEvents, client),
    );
    server.registerTool(
      "pretix_get_event",
      { description: "Get details of one event.", inputSchema: core.getEventInputSchema },
      wrap(core.getEvent, client),
    );
    server.registerTool(
      "pretix_create_event",
      { description: "Create a new event. It always starts offline (not live); use pretix_update_event to go live once it has a quota. Call with confirm=false first to preview.", inputSchema: core.createEventInputSchema },
      wrap(core.createEvent, client),
    );
    server.registerTool(
      "pretix_update_event",
      { description: "Update an event's name, dates, location, test mode, or take it live/offline. Call with confirm=false first to preview.", inputSchema: core.updateEventInputSchema },
      wrap(core.updateEvent, client),
    );
    server.registerTool(
      "pretix_list_items",
      { description: "List items (products) for an event.", inputSchema: core.listItemsInputSchema },
      wrap(core.listItems, client),
    );
    server.registerTool(
      "pretix_get_item",
      { description: "Get details of one item.", inputSchema: core.getItemInputSchema },
      wrap(core.getItem, client),
    );
    server.registerTool(
      "pretix_create_item",
      { description: "Create a new item (product). Call with confirm=false first to preview.", inputSchema: core.createItemInputSchema },
      wrap(core.createItem, client),
    );
    server.registerTool(
      "pretix_update_item",
      { description: "Update an existing item. Call with confirm=false first to preview.", inputSchema: core.updateItemInputSchema },
      wrap(core.updateItem, client),
    );
    server.registerTool(
      "pretix_list_categories",
      { description: "List item categories for an event.", inputSchema: core.listCategoriesInputSchema },
      wrap(core.listCategories, client),
    );
    server.registerTool(
      "pretix_create_category",
      { description: "Create a new item category. Call with confirm=false first to preview.", inputSchema: core.createCategoryInputSchema },
      wrap(core.createCategory, client),
    );
    server.registerTool(
      "pretix_list_tax_rules",
      { description: "List tax rules for an event.", inputSchema: core.listTaxRulesInputSchema },
      wrap(core.listTaxRules, client),
    );
    server.registerTool(
      "pretix_list_quotas",
      { description: "List quotas for an event.", inputSchema: core.listQuotasInputSchema },
      wrap(core.listQuotas, client),
    );
    server.registerTool(
      "pretix_get_quota_availability",
      { description: "Get detailed availability for a quota: total size, paid/pending counts, cart holds, blocking vouchers, waiting list.", inputSchema: core.getQuotaAvailabilityInputSchema },
      wrap(core.getQuotaAvailability, client),
    );
    server.registerTool(
      "pretix_create_quota",
      { description: "Create a new quota. Call with confirm=false first to preview.", inputSchema: core.createQuotaInputSchema },
      wrap(core.createQuota, client),
    );
    server.registerTool(
      "pretix_update_quota",
      { description: "Update an existing quota. Call with confirm=false first to preview.", inputSchema: core.updateQuotaInputSchema },
      wrap(core.updateQuota, client),
    );
    server.registerTool(
      "pretix_list_variations",
      { description: "List the variations of an item (e.g. table or zone options).", inputSchema: catalog.listVariationsInputSchema },
      wrap(catalog.listVariations, client),
    );
    server.registerTool(
      "pretix_create_variation",
      { description: "Add a variation to an item (switches the item to has_variations). Call with confirm=false first to preview.", inputSchema: catalog.createVariationInputSchema },
      wrap(catalog.createVariation, client),
    );
    server.registerTool(
      "pretix_update_variation",
      { description: "Update an item variation's name, price or active flag. Call with confirm=false first to preview.", inputSchema: catalog.updateVariationInputSchema },
      wrap(catalog.updateVariation, client),
    );
    server.registerTool(
      "pretix_list_questions",
      { description: "List custom questions (e.g. dietary restrictions, accessibility notes) asked per ticket.", inputSchema: catalog.listQuestionsInputSchema },
      wrap(catalog.listQuestions, client),
    );
    server.registerTool(
      "pretix_create_question",
      { description: "Create a custom per-ticket question such as dietary restrictions (choice) or accessibility needs (text). Answers are attached to order positions. Call with confirm=false first to preview.", inputSchema: catalog.createQuestionInputSchema },
      wrap(catalog.createQuestion, client),
    );
    server.registerTool(
      "pretix_update_question",
      { description: "Update a custom question. Call with confirm=false first to preview.", inputSchema: catalog.updateQuestionInputSchema },
      wrap(catalog.updateQuestion, client),
    );
    server.registerTool(
      "pretix_list_seating_plans",
      { description: "List organizer-level seating plans.", inputSchema: catalog.listSeatingPlansInputSchema },
      wrap(catalog.listSeatingPlans, client),
    );
    server.registerTool(
      "pretix_create_seating_plan",
      { description: "Create a seating plan from full layout JSON or a simple rows/tables grid. Call with confirm=false first to preview.", inputSchema: catalog.createSeatingPlanInputSchema },
      wrap(catalog.createSeatingPlan, client),
    );
    server.registerTool(
      "pretix_set_event_seating_plan",
      { description: "Attach a seating plan to an event and map seat categories to items (or detach with null). Call with confirm=false first to preview.", inputSchema: catalog.setEventSeatingPlanInputSchema },
      wrap(catalog.setEventSeatingPlan, client),
    );
    server.registerTool(
      "pretix_list_seats",
      { description: "List an event's seats with their GUIDs and whether they are taken or blocked.", inputSchema: catalog.listSeatsInputSchema },
      wrap(catalog.listSeats, client),
    );
    server.registerTool(
      "pretix_list_item_meta_properties",
      { description: "List the item metadata keys (per event) that items may carry in meta_data.", inputSchema: catalog.listItemMetaPropertiesInputSchema },
      wrap(catalog.listItemMetaProperties, client),
    );
    server.registerTool(
      "pretix_create_item_meta_property",
      { description: "Declare an item metadata key for an event. Required once before items can set meta_data for it. Call with confirm=false first to preview.", inputSchema: catalog.createItemMetaPropertyInputSchema },
      wrap(catalog.createItemMetaProperty, client),
    );
  }

  if (enabledGroups.has("sales")) {
    server.registerTool(
      "pretix_list_vouchers",
      { description: "List vouchers for an event.", inputSchema: sales.listVouchersInputSchema },
      wrap(sales.listVouchers, client),
    );
    server.registerTool(
      "pretix_get_voucher",
      { description: "Get details of one voucher.", inputSchema: sales.getVoucherInputSchema },
      wrap(sales.getVoucher, client),
    );
    server.registerTool(
      "pretix_create_voucher",
      { description: "Create a single voucher. Call with confirm=false first to preview.", inputSchema: sales.createVoucherInputSchema },
      wrap(sales.createVoucher, client),
    );
    server.registerTool(
      "pretix_batch_create_vouchers",
      { description: "Create many vouchers at once from a shared template, e.g. for a promo code batch. Call with confirm=false first to preview.", inputSchema: sales.batchCreateVouchersInputSchema },
      wrap(sales.batchCreateVouchers, client),
    );
    server.registerTool(
      "pretix_update_voucher",
      { description: "Update an existing voucher. Call with confirm=false first to preview.", inputSchema: sales.updateVoucherInputSchema },
      wrap(sales.updateVoucher, client),
    );
    server.registerTool(
      "pretix_delete_voucher",
      { description: "Delete a voucher. Call with confirm=false first to preview.", inputSchema: sales.deleteVoucherInputSchema },
      wrap(sales.deleteVoucher, client),
    );
    server.registerTool(
      "pretix_list_discounts",
      { description: "List automatic discounts configured for an event.", inputSchema: sales.listDiscountsInputSchema },
      wrap(sales.listDiscounts, client),
    );
    server.registerTool(
      "pretix_list_gift_cards",
      { description: "List gift cards for an organizer.", inputSchema: sales.listGiftCardsInputSchema },
      wrap(sales.listGiftCards, client),
    );
  }

  if (enabledGroups.has("crm")) {
    server.registerTool(
      "pretix_list_customers",
      { description: "List customer accounts for an organizer.", inputSchema: crm.listCustomersInputSchema },
      wrap(crm.listCustomers, client),
    );
    server.registerTool(
      "pretix_get_customer",
      { description: "Get details of one customer.", inputSchema: crm.getCustomerInputSchema },
      wrap(crm.getCustomer, client),
    );
    server.registerTool(
      "pretix_create_customer",
      { description: "Create a customer (shop buyer) account. Orders can be linked to it via pretix_create_order's customer_id. Call with confirm=false first to preview.", inputSchema: crm.createCustomerInputSchema },
      wrap(crm.createCustomer, client),
    );
    server.registerTool(
      "pretix_update_customer",
      { description: "Update a customer's email, name, phone, or enable/disable the account. Call with confirm=false first to preview.", inputSchema: crm.updateCustomerInputSchema },
      wrap(crm.updateCustomer, client),
    );
    server.registerTool(
      "pretix_list_memberships",
      { description: "List memberships for a customer.", inputSchema: crm.listMembershipsInputSchema },
      wrap(crm.listMemberships, client),
    );
    server.registerTool(
      "pretix_list_membership_types",
      { description: "List membership types available for an organizer.", inputSchema: crm.listMembershipTypesInputSchema },
      wrap(crm.listMembershipTypes, client),
    );
  }

  if (enabledGroups.has("admin")) {
    server.registerTool(
      "pretix_list_webhooks",
      { description: "List webhooks configured for an organizer.", inputSchema: admin.listWebhooksInputSchema },
      wrap(admin.listWebhooks, client),
    );
    server.registerTool(
      "pretix_create_webhook",
      { description: "Create a webhook. Note: pretix does not sign webhook payloads, so the receiver has no built-in way to verify their origin. Call with confirm=false first to preview.", inputSchema: admin.createWebhookInputSchema },
      wrap(admin.createWebhook, client),
    );
    server.registerTool(
      "pretix_update_webhook",
      { description: "Update an existing webhook. Call with confirm=false first to preview.", inputSchema: admin.updateWebhookInputSchema },
      wrap(admin.updateWebhook, client),
    );
    server.registerTool(
      "pretix_delete_webhook",
      { description: "Delete a webhook. Call with confirm=false first to preview.", inputSchema: admin.deleteWebhookInputSchema },
      wrap(admin.deleteWebhook, client),
    );
    server.registerTool(
      "pretix_list_devices",
      { description: "List check-in/scanning devices registered for an organizer.", inputSchema: admin.listDevicesInputSchema },
      wrap(admin.listDevices, client),
    );
  }

  return server;
}
