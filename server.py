#!/usr/bin/env python3
"""Dropbox MCP Server — file operations via Dropbox API.

Uses FastMCP for proper stdio protocol handling.
Token loaded from ~/.claude/channels/dropbox/.env
"""

import json
import os
from pathlib import Path

# Load .env
ENV_FILE = Path.home() / ".claude" / "channels" / "dropbox" / ".env"
try:
    for line in ENV_FILE.read_text().splitlines():
        if "=" in line and not line.startswith("#"):
            key, val = line.split("=", 1)
            if key.strip() not in os.environ:
                os.environ[key.strip()] = val.strip()
except Exception:
    pass

import dropbox
from mcp.server.fastmcp import FastMCP

DROPBOX_ROOT = Path(os.environ.get("DROPBOX_LOCAL_PATH", str(Path.home() / "Dropbox")))

mcp = FastMCP("dropbox_mcp")


def get_client():
    refresh_token = os.environ.get("DROPBOX_REFRESH_TOKEN", "")
    app_key = os.environ.get("DROPBOX_APP_KEY", "")
    app_secret = os.environ.get("DROPBOX_APP_SECRET", "")
    if refresh_token and app_key:
        return dropbox.Dropbox(
            oauth2_refresh_token=refresh_token, app_key=app_key, app_secret=app_secret
        )
    # Fallback to legacy access token
    return dropbox.Dropbox(os.environ.get("DROPBOX_ACCESS_TOKEN", ""))


@mcp.tool()
def dropbox_restore(path: str) -> str:
    """Restore a deleted file from Dropbox's server-side history. Finds the most recent revision and restores it."""
    dbx = get_client()
    revisions = dbx.files_list_revisions(path, limit=5)
    if not revisions.entries:
        return f"No revisions found for {path}"
    rev = revisions.entries[0].rev
    result = dbx.files_restore(path, rev)
    return f"Restored: {path} (rev: {rev}, size: {result.size} bytes)"


@mcp.tool()
def dropbox_restore_batch(paths: list[str]) -> str:
    """Restore multiple deleted files from Dropbox history."""
    dbx = get_client()
    results = []
    for path in paths:
        try:
            revisions = dbx.files_list_revisions(path, limit=5)
            if revisions.entries:
                rev = revisions.entries[0].rev
                dbx.files_restore(path, rev)
                results.append(f"  RESTORED: {path}")
            else:
                results.append(f"  NO REVISIONS: {path}")
        except Exception as e:
            results.append(f"  ERROR: {path} -> {str(e)[:100]}")
    restored = sum(1 for r in results if "RESTORED" in r)
    results.append(f"\nRestored: {restored}/{len(paths)}")
    return "\n".join(results)


@mcp.tool()
def dropbox_download(path: str) -> str:
    """Force-download a file from Dropbox servers to the local Dropbox folder. Useful when Smart Sync keeps files cloud-only."""
    dbx = get_client()
    local_path = DROPBOX_ROOT / path.lstrip("/")
    local_path.parent.mkdir(parents=True, exist_ok=True)
    meta, response = dbx.files_download(path)
    local_path.write_bytes(response.content)
    return f"Downloaded: {path} -> {local_path} ({meta.size} bytes)"


@mcp.tool()
def dropbox_search(query: str, path: str = "", max_results: int = 20) -> str:
    """Search for files on Dropbox by name or content. Returns results with path, size, and modified date."""
    dbx = get_client()
    options = dropbox.files.SearchOptions(
        path=path,
        max_results=min(max_results, 100),
        file_status=dropbox.files.FileStatus.active,
    )
    result = dbx.files_search_v2(query, options=options)
    matches = []
    for match in result.matches:
        meta = match.metadata.get_metadata()
        if isinstance(meta, dropbox.files.FileMetadata):
            matches.append(
                {
                    "path": meta.path_display,
                    "size_mb": round(meta.size / (1024 * 1024), 2),
                    "modified": meta.server_modified.isoformat()
                    if meta.server_modified
                    else "unknown",
                }
            )
    if not matches:
        return f"No results for '{query}'"
    lines = [f"Found {len(matches)} results for '{query}':"]
    for m in matches:
        lines.append(f"  {m['size_mb']:>8} MB  {m['modified'][:10]}  {m['path']}")
    return "\n".join(lines)


@mcp.tool()
def dropbox_list_deleted(path: str, recursive: bool = False) -> str:
    """List recently deleted files in a Dropbox folder. Shows files that can be restored."""
    dbx = get_client()
    result = dbx.files_list_folder(path, recursive=recursive, include_deleted=True)
    deleted = []
    while True:
        for entry in result.entries:
            if isinstance(entry, dropbox.files.DeletedMetadata):
                deleted.append(entry.path_display)
        if not result.has_more:
            break
        result = dbx.files_list_folder_continue(result.cursor)
    if not deleted:
        return f"No deleted files found in {path}"
    lines = [f"Found {len(deleted)} deleted files in {path}:"]
    for d in deleted[:50]:
        lines.append(f"  {d}")
    if len(deleted) > 50:
        lines.append(f"  ... and {len(deleted) - 50} more")
    return "\n".join(lines)


@mcp.tool()
def dropbox_file_info(path: str) -> str:
    """Get metadata for a file on Dropbox servers: size, modified date, revision, content hash."""
    dbx = get_client()
    meta = dbx.files_get_metadata(path)
    if isinstance(meta, dropbox.files.FileMetadata):
        return json.dumps(
            {
                "path": meta.path_display,
                "size": meta.size,
                "size_mb": round(meta.size / (1024 * 1024), 2),
                "modified": meta.server_modified.isoformat() if meta.server_modified else None,
                "rev": meta.rev,
                "content_hash": meta.content_hash,
            },
            indent=2,
        )
    elif isinstance(meta, dropbox.files.FolderMetadata):
        return json.dumps({"path": meta.path_display, "type": "folder"}, indent=2)
    return f"Unknown metadata type for {path}"


@mcp.tool()
def dropbox_list_revisions(path: str, limit: int = 10) -> str:
    """List all available revisions of a file. Useful for finding older versions to restore."""
    dbx = get_client()
    result = dbx.files_list_revisions(path, limit=min(limit, 100))
    if not result.entries:
        return f"No revisions found for {path}"
    lines = [f"Revisions for {path} ({len(result.entries)} found):"]
    for entry in result.entries:
        modified = entry.server_modified.isoformat() if entry.server_modified else "unknown"
        lines.append(f"  rev: {entry.rev}  size: {entry.size:>10,} bytes  modified: {modified}")
    return "\n".join(lines)


@mcp.tool()
def dropbox_restore_revision(path: str, rev: str) -> str:
    """Restore a specific revision of a file by revision ID."""
    dbx = get_client()
    result = dbx.files_restore(path, rev)
    return f"Restored: {path} to revision {rev} ({result.size} bytes)"


if __name__ == "__main__":
    mcp.run()
