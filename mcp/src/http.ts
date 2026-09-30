import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadConfigFromEnv } from "./client.js";
import { createServer, loadToolGroupsFromEnv } from "./server.js";

const config = loadConfigFromEnv();
const port = Number(process.env.PRETIX_MCP_PORT ?? "3000");

// Stateless mode: no session ID tracking, every request is independent.
// This matches how this server is actually used - a long-running
// single-tenant service with no per-client session state to maintain,
// not a multi-client stateful protocol negotiation.
const transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: undefined,
});

const groups = loadToolGroupsFromEnv();
const mcpServer = createServer(config, groups);
await mcpServer.connect(transport);

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

  try {
    const bodyText = await readBody(req);
    const parsedBody = bodyText ? JSON.parse(bodyText) : undefined;
    await transport.handleRequest(req, res, parsedBody);
  } catch (err) {
    console.error("Error handling MCP request:", err);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal server error" }));
    }
  }
});

httpServer.listen(port, () => {
  console.log(`pretix-mcp HTTP server listening on port ${port}`);
  console.log(`  MCP endpoint:    http://0.0.0.0:${port}/mcp`);
  console.log(`  Health check:    http://0.0.0.0:${port}/health`);
});
