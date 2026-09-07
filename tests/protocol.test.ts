import { describe, it, expect, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/server";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const serverEntry = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

function spawnTransport(): StdioClientTransport {
  return new StdioClientTransport({ command: "node", args: [serverEntry] });
}

describe("MCP protocol", () => {
  let client: Client | undefined;

  afterEach(async () => {
    await client?.close();
    client = undefined;
  });

  it("negotiates the SDK's latest protocol version and lists tools", async () => {
    // Do NOT pin a version. This test pinned "2026-07-28" and asserted the
    // negotiated version equalled that pin, which is a version the SDK never
    // offers -- so it failed on main with "the server did not offer pinned
    // protocol version". Asserting LATEST_PROTOCOL_VERSION means the test tracks
    // whatever the SDK actually speaks instead of a number typed into the test.
    client = new Client({ name: "dropbox-mcp-test", version: "1.0.0" });
    await client.connect(spawnTransport());

    expect(client.getNegotiatedProtocolVersion()).toBe(LATEST_PROTOCOL_VERSION);

    const { tools } = await client.listTools();
    expect(tools).toHaveLength(11);
    expect(tools.map((t) => t.name).sort()).toEqual([
      "dropbox_delete",
      "dropbox_download",
      "dropbox_file_info",
      "dropbox_list_deleted",
      "dropbox_list_revisions",
      "dropbox_move",
      "dropbox_restore",
      "dropbox_restore_batch",
      "dropbox_restore_revision",
      "dropbox_search",
      "dropbox_upload",
    ]);
  });

  it("still serves legacy 2025-era clients via auto negotiation", async () => {
    client = new Client(
      { name: "dropbox-mcp-test", version: "1.0.0" },
      { versionNegotiation: { mode: "auto", probe: { timeoutMs: 5_000 } } },
    );
    await client.connect(spawnTransport());

    const era = client.getProtocolEra();
    expect(era === "modern" || era === "legacy").toBe(true);

    const { tools } = await client.listTools();
    expect(tools).toHaveLength(11);
  });
});
