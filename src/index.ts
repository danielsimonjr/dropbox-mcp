#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig, getClient } from "./dropbox.js";
import { TOOLS, HANDLERS } from "./tools.js";

const config = loadConfig();
const client = getClient(config);

// Injected by scripts/bundle.mjs via esbuild `define`, read from package.json at build
// time. A hardcoded literal makes the running server report a stale version to every
// client regardless of the manifests, and serverInfo is the ONLY version a client can
// observe -- so a wrong one hides drift from every manifest-comparing sweep.
declare const __PKG_VERSION__: string;
const VERSION = typeof __PKG_VERSION__ !== "undefined" ? __PKG_VERSION__ : "0.0.0-dev";

const server = new Server(
  { name: "dropbox_mcp", version: VERSION },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const handler = HANDLERS[name];
  if (!handler) {
    return { isError: true, content: [{ type: "text", text: `Unknown tool: ${name}` }] };
  }
  try {
    const text = await handler(client, config, args ?? {});
    return { content: [{ type: "text", text }] };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { isError: true, content: [{ type: "text", text: `Error in ${name}: ${msg}` }] };
  }
});

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("dropbox-mcp: connected on stdio");
}

main().catch((e) => {
  console.error("dropbox-mcp: fatal:", e);
  process.exit(1);
});
