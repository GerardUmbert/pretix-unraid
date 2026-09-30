import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfigFromEnv } from "./client.js";
import { createServer, loadToolGroupsFromEnv } from "./server.js";

const config = loadConfigFromEnv();
const groups = loadToolGroupsFromEnv();
const server = createServer(config, groups);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal error starting pretix-mcp:", err);
  process.exit(1);
});
