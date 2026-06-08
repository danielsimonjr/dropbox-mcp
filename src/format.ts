/** Right-justify `s` to `width` with spaces (Python `{:>width}`). */
export function padLeft(s: string | number, width: number): string {
  return String(s).padStart(width, " ");
}

/** Group integer thousands with commas (Python `{:,}`). */
export function withCommas(n: number): string {
  return n.toLocaleString("en-US");
}

/** Bytes -> MB rounded to 2 decimals (Python `round(x, 2)`). */
export function bytesToMb(bytes: number): number {
  return Math.round((bytes / (1024 * 1024)) * 100) / 100;
}

/** Render a number like Python's float repr: whole numbers keep one decimal (1 -> "1.0"). */
export function pyFloat(n: number): string {
  return Number.isInteger(n) ? n.toFixed(1) : String(n);
}

export interface SearchMatch { path: string; size_mb: number; modified: string; }
export interface RevisionEntry { rev: string; size: number; modified: string; }

export function formatRestore(path: string, rev: string, size: number): string {
  return `Restored: ${path} (rev: ${rev}, size: ${size} bytes)`;
}

export function formatRestoreRevision(path: string, rev: string, size: number): string {
  return `Restored: ${path} to revision ${rev} (${size} bytes)`;
}

export function formatRestoreBatch(lines: string[], restored: number, total: number): string {
  return [...lines, `\nRestored: ${restored}/${total}`].join("\n");
}

export function formatDownload(path: string, localPath: string, size: number): string {
  return `Downloaded: ${path} -> ${localPath} (${size} bytes)`;
}

export function formatUpload(path: string, size: number, mode: string): string {
  return `Uploaded: ${path} (${size} bytes, mode: ${mode})`;
}

export function formatMove(fromPath: string, toPath: string): string {
  return `Moved: ${fromPath} -> ${toPath}`;
}

export function formatDelete(path: string): string {
  return `Deleted: ${path} (recoverable via dropbox_restore for ~30 days)`;
}

export function formatSearch(query: string, matches: SearchMatch[]): string {
  if (matches.length === 0) return `No results for '${query}'`;
  const lines = [`Found ${matches.length} results for '${query}':`];
  for (const m of matches) {
    lines.push(`  ${padLeft(pyFloat(m.size_mb), 8)} MB  ${m.modified.slice(0, 10)}  ${m.path}`);
  }
  return lines.join("\n");
}

export function formatListDeleted(path: string, deleted: string[]): string {
  if (deleted.length === 0) return `No deleted files found in ${path}`;
  const lines = [`Found ${deleted.length} deleted files in ${path}:`];
  for (const d of deleted.slice(0, 50)) lines.push(`  ${d}`);
  if (deleted.length > 50) lines.push(`  ... and ${deleted.length - 50} more`);
  return lines.join("\n");
}

export function formatListRevisions(path: string, entries: RevisionEntry[]): string {
  if (entries.length === 0) return `No revisions found for ${path}`;
  const lines = [`Revisions for ${path} (${entries.length} found):`];
  for (const e of entries) {
    lines.push(`  rev: ${e.rev}  size: ${padLeft(withCommas(e.size), 10)} bytes  modified: ${e.modified}`);
  }
  return lines.join("\n");
}

/** file_info: JSON, 2-space indent (Python json.dumps(indent=2)).
 *  `size_mb`, when present, is rendered as a Python-style float (whole numbers keep ".0"). */
export function formatFileInfo(obj: Record<string, unknown>): string {
  if (typeof obj.size_mb !== "number") {
    return JSON.stringify(obj, null, 2);
  }
  const SENTINEL = "@@DROPBOX_MCP_SIZE_MB@@";
  const token = pyFloat(obj.size_mb);
  const json = JSON.stringify({ ...obj, size_mb: SENTINEL }, null, 2);
  return json.replace(`"${SENTINEL}"`, token);
}
