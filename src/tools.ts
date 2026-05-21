import type { Tool } from "@modelcontextprotocol/sdk/types.js";

const str = (description: string) => ({ type: "string" as const, description });
const ro = { readOnlyHint: true };
const destructive = { destructiveHint: true };

export const TOOLS: Tool[] = [
  {
    name: "dropbox_restore",
    description: "Restore a deleted file from Dropbox's server-side history. Finds the most recent revision and restores it.",
    inputSchema: { type: "object", properties: { path: str("Dropbox path of the file to restore") }, required: ["path"] },
    annotations: destructive,
  },
  {
    name: "dropbox_restore_batch",
    description: "Restore multiple deleted files from Dropbox history.",
    inputSchema: {
      type: "object",
      properties: { paths: { type: "array", items: { type: "string" }, description: "Dropbox paths to restore" } },
      required: ["paths"],
    },
    annotations: destructive,
  },
  {
    name: "dropbox_restore_revision",
    description: "Restore a specific revision of a file by revision ID.",
    inputSchema: {
      type: "object",
      properties: { path: str("Dropbox path of the file"), rev: str("Revision ID to restore to") },
      required: ["path", "rev"],
    },
    annotations: destructive,
  },
  {
    name: "dropbox_download",
    description: "Force-download a file from Dropbox servers to the local Dropbox folder. Useful when Smart Sync keeps files cloud-only.",
    inputSchema: { type: "object", properties: { path: str("Dropbox path of the file to download") }, required: ["path"] },
    annotations: destructive,
  },
  {
    name: "dropbox_search",
    description: "Search for files on Dropbox by name or content. Returns results with path, size, and modified date.",
    inputSchema: {
      type: "object",
      properties: {
        query: str("Search query"),
        path: str("Folder to scope the search to (default: whole account)"),
        max_results: { type: "number", description: "Maximum results, capped at 100 (default 20)" },
      },
      required: ["query"],
    },
    annotations: ro,
  },
  {
    name: "dropbox_list_deleted",
    description: "List recently deleted files in a Dropbox folder. Shows files that can be restored.",
    inputSchema: {
      type: "object",
      properties: {
        path: str("Dropbox folder path"),
        recursive: { type: "boolean", description: "Recurse into subfolders (default false)" },
      },
      required: ["path"],
    },
    annotations: ro,
  },
  {
    name: "dropbox_file_info",
    description: "Get metadata for a file on Dropbox servers: size, modified date, revision, content hash.",
    inputSchema: { type: "object", properties: { path: str("Dropbox path") }, required: ["path"] },
    annotations: ro,
  },
  {
    name: "dropbox_list_revisions",
    description: "List all available revisions of a file. Useful for finding older versions to restore.",
    inputSchema: {
      type: "object",
      properties: {
        path: str("Dropbox path of the file"),
        limit: { type: "number", description: "Maximum revisions, capped at 100 (default 10)" },
      },
      required: ["path"],
    },
    annotations: ro,
  },
];
