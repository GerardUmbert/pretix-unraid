import { createHash, timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadConfigFromEnv } from "./client.js";
import { createServer, loadToolGroupsFromEnv } from "./server.js";

// Streamable HTTP transport, meant to sit behind the container's nginx at
// /mcp. It holds a pretix API token, so it refuses to start without a
// bearer secret and only listens on localhost - nginx is the only way in.
const config = loadConfigFromEnv();
const groups = loadToolGroupsFromEnv();
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

const httpServer = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
  if (req.url === "/health" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
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
