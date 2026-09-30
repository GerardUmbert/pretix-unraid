import { createHash, timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { PretixClient, PretixApiError, loadConfigFromEnv } from "./client.js";
import * as lab from "./lab.js";
import { LAB_PAGE } from "./lab-page.js";
import { createServer, loadToolGroupsFromEnv } from "./server.js";

// Streamable HTTP transport, meant to sit behind the container's nginx at
// /mcp. It holds a pretix API token, so it refuses to start without a
// bearer secret and only listens on localhost - nginx is the only way in.
const config = loadConfigFromEnv();
const groups = loadToolGroupsFromEnv();
const labClient = new PretixClient(config);
const port = Number(process.env.PRETIX_MCP_PORT ?? "3000");
const host = process.env.PRETIX_MCP_HOST ?? "127.0.0.1";

const secret = process.env.PRETIX_MCP_TOKEN;
if (!secret || secret.length < 24) {
  console.error("PRETIX_MCP_TOKEN must be set to a secret of at least 24 characters");
  process.exit(1);
}
const expectedDigest = createHash("sha256").update(`Bearer ${secret}`).digest();

function isAuthorized(req: IncomingMessage): boolean {
  const provided = createHash("sha256")
    .update(req.headers.authorization ?? "")
    .digest();
  return timingSafeEqual(provided, expectedDigest);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}


function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function handleLabApi(req: IncomingMessage, res: ServerResponse, action: string) {
  if (!isAuthorized(req)) {
    res.writeHead(401, { "Content-Type": "application/json", "WWW-Authenticate": "Bearer" });
    res.end(JSON.stringify({ error: "Unauthorized" }));
    return;
  }
  try {
    if (action === "events" && req.method === "GET") return json(res, 200, await lab.listEvents(labClient));
    if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });

    const bodyText = await readBody(req);
    const body = (bodyText ? JSON.parse(bodyText) : {}) as Record<string, any>;
    const count = Math.max(1, Math.min(100, Number(body.count) || 1));
    const needEvent = () => {
      if (typeof body.event !== "string" || !body.event) throw new Error("Pick an event first.");
      return body.event as string;
    };

    switch (action) {
      case "demo":
        return json(res, 200, await lab.createDemoEvent(labClient));
      case "seed":
        return json(res, 200, await lab.seedOrders(labClient, { event: needEvent(), count }));
      case "transfer":
        return json(res, 200, await lab.randomTransfer(labClient, {
          event: needEvent(),
          order_code: body.order_code || undefined,
          name: body.name || undefined,
          email: body.email || undefined,
          reissue: body.reissue !== false,
        }));
      case "checkin":
        return json(res, 200, await lab.randomCheckins(labClient, { event: needEvent(), count }));
      case "cancel":
        return json(res, 200, await lab.randomCancels(labClient, { event: needEvent(), count }));
      case "clear":
        if (body.confirm !== "CLEAR") return json(res, 400, { error: "Type CLEAR to confirm." });
        return json(res, 200, await lab.clearTestData(labClient));
      default:
        return json(res, 404, { error: "Unknown action" });
    }
  } catch (err) {
    const message = err instanceof PretixApiError ? `pretix ${err.status}: ${JSON.stringify(err.body)}` : err instanceof Error ? err.message : String(err);
    json(res, 400, { error: message });
  }
}

const httpServer = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
  // One line per request (never the secret or body) so connection problems
  // can be diagnosed from `docker logs`.
  const startedAt = Date.now();
  res.on("close", () => {
    console.log(
      `[mcp] ${req.method} ${req.url} mcp-method=${req.headers["mcp-method"] ?? "-"} ` +
        `proto=${req.headers["mcp-protocol-version"] ?? "-"} -> ${res.statusCode} ` +
        `${Date.now() - startedAt}ms`,
    );
  });

  if (req.url === "/health" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  const path = (req.url ?? "").split("?")[0];

  // Test lab: the page itself is static (no data, no secrets); every
  // /lab/api call needs the same bearer secret as /mcp.
  if (path === "/lab" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(LAB_PAGE);
    return;
  }
  if (path.startsWith("/lab/api/")) {
    await handleLabApi(req, res, path.slice("/lab/api/".length));
    return;
  }

  if (req.url !== "/mcp") {
    res.writeHead(404).end();
    return;
  }

  if (!isAuthorized(req)) {
    res.writeHead(401, { "Content-Type": "application/json", "WWW-Authenticate": "Bearer" });
    res.end(JSON.stringify({ error: "Unauthorized" }));
    return;
  }

  // Stateless server: no sessions and no server-initiated messages, so the
  // optional GET event stream and DELETE session-teardown do not apply.
  // Answering 405 (instead of holding a stream open forever) is what MCP
  // clients expect here.
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json", Allow: "POST" });
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  try {
    const bodyText = await readBody(req);
    const parsedBody = bodyText ? JSON.parse(bodyText) : undefined;
    // Stateless mode: a fresh server + transport per request, so no session
    // state is shared between callers (the SDK forbids reusing a stateless
    // transport across requests).
    const mcpServer = createServer(config, groups);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void mcpServer.close();
    });
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, parsedBody);
  } catch (err) {
    console.error("Error handling MCP request:", err);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal server error" }));
    }
  }
});

httpServer.listen(port, host, () => {
  console.log(`pretix-mcp HTTP server listening on ${host}:${port} (endpoint /mcp, bearer auth required)`);
});
