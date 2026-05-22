import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Dropbox } from "dropbox";
import type { DropboxConfig } from "./dropbox.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  bytesToMb, formatSearch, formatListDeleted, formatFileInfo, formatListRevisions,
  formatRestore, formatRestoreBatch, formatRestoreRevision, formatDownload,
  type SearchMatch,
} from "./format.js";

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

export type ToolHandler = (client: Dropbox, config: DropboxConfig, rawArgs: unknown) => Promise<string>;

/** Render a Dropbox timestamp like Python's datetime.isoformat(): the Python SDK
 *  parses server_modified to a naive datetime, so the trailing 'Z' is dropped. */
function pyTimestamp(iso: string): string {
  return iso.replace(/Z$/, "");
}

async function handleSearch(client: Dropbox, _c: DropboxConfig, raw: unknown): Promise<string> {
  const { query, path, max_results } = z
    .object({ query: z.string(), path: z.string().default(""), max_results: z.number().default(20) })
    .parse(raw);
  const res = await client.filesSearchV2({
    query,
    options: { path, max_results: Math.min(max_results, 100), file_status: { ".tag": "active" } },
  });
  const matches: SearchMatch[] = [];
  for (const m of res.result.matches) {
    if (m.metadata[".tag"] !== "metadata") continue;
    const meta = m.metadata.metadata;
    if (meta[".tag"] === "file") {
      matches.push({
        path: meta.path_display ?? "",
        size_mb: bytesToMb(meta.size),
        modified: meta.server_modified ? pyTimestamp(meta.server_modified) : "unknown",
      });
    }
  }
  return formatSearch(query, matches);
}

async function handleListDeleted(client: Dropbox, _c: DropboxConfig, raw: unknown): Promise<string> {
  const { path, recursive } = z
    .object({ path: z.string(), recursive: z.boolean().default(false) })
    .parse(raw);
  const deleted: string[] = [];
  let res = await client.filesListFolder({ path, recursive, include_deleted: true });
  for (;;) {
    for (const e of res.result.entries) {
      if (e[".tag"] === "deleted" && e.path_display) deleted.push(e.path_display);
    }
    if (!res.result.has_more) break;
    res = await client.filesListFolderContinue({ cursor: res.result.cursor });
  }
  return formatListDeleted(path, deleted);
}

async function handleFileInfo(client: Dropbox, _c: DropboxConfig, raw: unknown): Promise<string> {
  const { path } = z.object({ path: z.string() }).parse(raw);
  const meta = (await client.filesGetMetadata({ path })).result;
  if (meta[".tag"] === "file") {
    return formatFileInfo({
      path: meta.path_display,
      size: meta.size,
      size_mb: bytesToMb(meta.size),
      modified: meta.server_modified ? pyTimestamp(meta.server_modified) : null,
      rev: meta.rev,
      content_hash: meta.content_hash ?? null,
    });
  }
  if (meta[".tag"] === "folder") {
    return formatFileInfo({ path: meta.path_display, type: "folder" });
  }
  return `Unknown metadata type for ${path}`;
}

async function handleListRevisions(client: Dropbox, _c: DropboxConfig, raw: unknown): Promise<string> {
  const { path, limit } = z
    .object({ path: z.string(), limit: z.number().default(10) })
    .parse(raw);
  const res = await client.filesListRevisions({ path, limit: Math.min(limit, 100) });
  return formatListRevisions(
    path,
    res.result.entries.map((e) => ({
      rev: e.rev, size: e.size, modified: e.server_modified ? pyTimestamp(e.server_modified) : "unknown",
    })),
  );
}

async function handleRestore(client: Dropbox, _c: DropboxConfig, raw: unknown): Promise<string> {
  const { path } = z.object({ path: z.string() }).parse(raw);
  const revs = await client.filesListRevisions({ path, limit: 5 });
  if (revs.result.entries.length === 0) return `No revisions found for ${path}`;
  const rev = revs.result.entries[0].rev;
  const res = await client.filesRestore({ path, rev });
  return formatRestore(path, rev, res.result.size);
}

async function handleRestoreBatch(client: Dropbox, _c: DropboxConfig, raw: unknown): Promise<string> {
  const { paths } = z.object({ paths: z.array(z.string()) }).parse(raw);
  const lines: string[] = [];
  for (const path of paths) {
    try {
      const revs = await client.filesListRevisions({ path, limit: 5 });
      if (revs.result.entries.length > 0) {
        await client.filesRestore({ path, rev: revs.result.entries[0].rev });
        lines.push(`  RESTORED: ${path}`);
      } else {
        lines.push(`  NO REVISIONS: ${path}`);
      }
    } catch (e) {
      lines.push(`  ERROR: ${path} -> ${String(e instanceof Error ? e.message : e).slice(0, 100)}`);
    }
  }
  const restored = lines.filter((l) => l.includes("RESTORED")).length;
  return formatRestoreBatch(lines, restored, paths.length);
}

async function handleRestoreRevision(client: Dropbox, _c: DropboxConfig, raw: unknown): Promise<string> {
  const { path, rev } = z.object({ path: z.string(), rev: z.string() }).parse(raw);
  const res = await client.filesRestore({ path, rev });
  return formatRestoreRevision(path, rev, res.result.size);
}

async function handleDownload(client: Dropbox, config: DropboxConfig, raw: unknown): Promise<string> {
  const { path } = z.object({ path: z.string() }).parse(raw);
  const localPath = join(config.localPath, path.replace(/^\/+/, ""));
  mkdirSync(dirname(localPath), { recursive: true });
  const res = await client.filesDownload({ path });
  // On Node the download payload carries `fileBinary` (a Buffer) injected at runtime,
  // but the SDK types only declare FileMetadata. Cast through unknown first.
  const data = (res.result as unknown as { fileBinary: Buffer }).fileBinary;
  writeFileSync(localPath, data);
  return formatDownload(path, localPath, res.result.size);
}

export const HANDLERS: Record<string, ToolHandler> = {
  dropbox_restore: handleRestore,
  dropbox_restore_batch: handleRestoreBatch,
  dropbox_restore_revision: handleRestoreRevision,
  dropbox_download: handleDownload,
  dropbox_search: handleSearch,
  dropbox_list_deleted: handleListDeleted,
  dropbox_file_info: handleFileInfo,
  dropbox_list_revisions: handleListRevisions,
};
