import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Dropbox } from "dropbox";
import type { DropboxConfig } from "./dropbox.js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  bytesToMb, formatSearch, formatListDeleted, formatFileInfo, formatListRevisions,
  formatRestore, formatRestoreBatch, formatRestoreRevision, formatDownload,
  formatUpload, formatMove, formatDelete,
  type SearchMatch,
} from "./format.js";

/** Dropbox single-request upload limit. Larger files need an upload session. */
const MAX_SINGLE_UPLOAD = 150 * 1024 * 1024;

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
    name: "dropbox_upload",
    description: "Upload a local file to Dropbox (single file, atomic). Source defaults to the local Dropbox-folder mirror of `path`; pass `local_path` to upload an arbitrary local file. Mode 'add' (default) fails if the destination exists; 'overwrite' replaces it. Files larger than 150 MB are rejected (Dropbox requires a chunked upload session for those — use the desktop client). For bulk uploads of many files, use the dropbox skill's dbx_sync.py instead.",
    inputSchema: {
      type: "object",
      properties: {
        path: str("Dropbox destination path, e.g. /Misc/report.pdf"),
        local_path: str("Local source file path (default: <local Dropbox folder>/<path>)"),
        mode: { type: "string", enum: ["add", "overwrite"], description: "add = fail if destination exists (default); overwrite = replace it" },
      },
      required: ["path"],
    },
    annotations: destructive,
  },
  {
    name: "dropbox_move",
    description: "Move or rename a file or folder on Dropbox server-side (no download/re-upload). Use for cross-folder relocation or renaming. Set autorename=true to auto-rename instead of failing when the destination already exists.",
    inputSchema: {
      type: "object",
      properties: {
        from_path: str("Current Dropbox path"),
        to_path: str("New Dropbox path"),
        autorename: { type: "boolean", description: "If destination exists, auto-rename instead of failing (default false)" },
      },
      required: ["from_path", "to_path"],
    },
    annotations: destructive,
  },
  {
    name: "dropbox_delete",
    description: "Delete a file or folder on Dropbox. The item moves to Dropbox trash and is recoverable via dropbox_restore for ~30 days (longer on some plans). Deleting a folder removes all of its contents. Confirm intent before deleting folders.",
    inputSchema: {
      type: "object",
      properties: { path: str("Dropbox path of the file or folder to delete") },
      required: ["path"],
    },
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

/** Map a Dropbox path to its local file path under config.localPath, rejecting any
 *  path that escapes the sync root (e.g. "/../../etc/passwd"). Without this, a
 *  caller-supplied Dropbox path could write to or read from arbitrary disk locations. */
function resolveLocalPath(config: DropboxConfig, dropboxPath: string): string {
  const root = resolve(config.localPath);
  const target = resolve(root, dropboxPath.replace(/^\/+/, ""));
  const rel = relative(root, target);
  if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) {
    throw new Error(`Refusing path outside the Dropbox sync root: ${dropboxPath}`);
  }
  return target;
}

async function handleDownload(client: Dropbox, config: DropboxConfig, raw: unknown): Promise<string> {
  const { path } = z.object({ path: z.string() }).parse(raw);
  const localPath = resolveLocalPath(config, path);
  mkdirSync(dirname(localPath), { recursive: true });
  const res = await client.filesDownload({ path });
  // On Node the download payload carries `fileBinary` (a Buffer) injected at runtime,
  // but the SDK types only declare FileMetadata. Cast through unknown first.
  const data = (res.result as unknown as { fileBinary: Buffer }).fileBinary;
  writeFileSync(localPath, data);
  return formatDownload(path, localPath, res.result.size);
}

async function handleUpload(client: Dropbox, config: DropboxConfig, raw: unknown): Promise<string> {
  const { path, local_path, mode } = z
    .object({
      path: z.string(),
      local_path: z.string().optional(),
      mode: z.enum(["add", "overwrite"]).default("add"),
    })
    .parse(raw);
  const src = local_path ?? resolveLocalPath(config, path);
  const data = readFileSync(src);
  if (data.length > MAX_SINGLE_UPLOAD) {
    throw new Error(
      `File too large for single-request upload (${data.length} bytes > 150 MB). ` +
        `Use the Dropbox desktop client or a chunked-upload session for files this size.`,
    );
  }
  try {
    const res = await client.filesUpload({ path, contents: data, mode: { ".tag": mode } });
    return formatUpload(res.result.path_display ?? path, res.result.size, mode);
  } catch (e) {
    if (mode === "add" && isWriteConflict(e)) {
      throw new Error(
        `Destination already exists: ${path}. ` +
          `Pass mode="overwrite" to replace it, or move/delete the existing file first.`,
      );
    }
    throw e;
  }
}

/** A Dropbox add-mode write collision surfaces as HTTP 409. The SDK's raw message
 *  ("Response failed with a 409 code") is opaque; we translate it to actionable text. */
function isWriteConflict(e: unknown): boolean {
  return (e as { status?: number })?.status === 409;
}

async function handleMove(client: Dropbox, _c: DropboxConfig, raw: unknown): Promise<string> {
  const { from_path, to_path, autorename } = z
    .object({ from_path: z.string(), to_path: z.string(), autorename: z.boolean().default(false) })
    .parse(raw);
  const res = await client.filesMoveV2({ from_path, to_path, autorename });
  const dest = (res.result.metadata as { path_display?: string }).path_display ?? to_path;
  return formatMove(from_path, dest);
}

async function handleDelete(client: Dropbox, _c: DropboxConfig, raw: unknown): Promise<string> {
  const { path } = z.object({ path: z.string() }).parse(raw);
  const res = await client.filesDeleteV2({ path });
  const deleted = (res.result.metadata as { path_display?: string }).path_display ?? path;
  return formatDelete(deleted);
}

export const HANDLERS: Record<string, ToolHandler> = {
  dropbox_restore: handleRestore,
  dropbox_restore_batch: handleRestoreBatch,
  dropbox_restore_revision: handleRestoreRevision,
  dropbox_download: handleDownload,
  dropbox_upload: handleUpload,
  dropbox_move: handleMove,
  dropbox_delete: handleDelete,
  dropbox_search: handleSearch,
  dropbox_list_deleted: handleListDeleted,
  dropbox_file_info: handleFileInfo,
  dropbox_list_revisions: handleListRevisions,
};
