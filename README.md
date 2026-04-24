# dropbox-mcp

An MCP (Model Context Protocol) server that exposes the Dropbox API as tools for LLM
agents. Built on [FastMCP](https://github.com/modelcontextprotocol/python-sdk) and
[dropbox-sdk-python](https://github.com/dropbox/dropbox-sdk-python).

Focus: **recovery and discovery on an existing Dropbox account** — restoring deleted
files, listing revisions, searching content, and force-downloading cloud-only files.
The server talks to the Dropbox *server-side* API, not the local sync folder, so it
can see and restore files that local sync has already deleted.

---

## Tools

All tool names are prefixed `dropbox_` to avoid collisions with other MCP servers.

| Tool | Behavior | Read-only |
|---|---|---|
| `dropbox_restore` | Restore the most recent server-side revision of a deleted file. | No |
| `dropbox_restore_batch` | Restore multiple files in one call; reports per-path result. | No |
| `dropbox_restore_revision` | Restore a specific revision ID (e.g., a known-good earlier version). | No |
| `dropbox_download` | Force-download a file from Dropbox to the local sync folder, bypassing Smart Sync cloud-only state. | No |
| `dropbox_search` | Search by filename or content across the account. Returns path, size, modified date. | Yes |
| `dropbox_list_deleted` | List deleted entries in a folder (optionally recursive). Input for restore workflows. | Yes |
| `dropbox_file_info` | Return size, modified time, revision ID, and content hash for a path. | Yes |
| `dropbox_list_revisions` | List up to 100 revisions of a file with rev ID, size, and modified time. | Yes |

Read-only tools are safe to call freely. The four restore/download tools mutate state
on Dropbox servers or local disk.

---

## Installation

### Prerequisites

- Python 3.10 or newer
- A Dropbox account and a [Dropbox app](https://www.dropbox.com/developers/apps)
  with `files.content.read`, `files.content.write`, and `files.metadata.read` scopes

### Install

```bash
git clone https://github.com/danielsimonjr/dropbox-mcp.git
cd dropbox-mcp
pip install -e .
```

Or, for dependencies only:

```bash
pip install -r requirements.txt
```

---

## Authentication

The server loads credentials from `~/.claude/channels/dropbox/.env` on startup. Create
that file and paste in the template below, then fill in your values:

```bash
mkdir -p ~/.claude/channels/dropbox
touch ~/.claude/channels/dropbox/.env
```

Template:

```ini
# --- Option A: OAuth 2 refresh token (recommended) ---
# Create an app at https://www.dropbox.com/developers/apps, enable the scopes
# files.content.read, files.content.write, files.metadata.read, then run the
# OAuth flow once to obtain a refresh token.
DROPBOX_REFRESH_TOKEN=
DROPBOX_APP_KEY=
DROPBOX_APP_SECRET=

# --- Option B: Long-lived access token (fallback) ---
# Leave blank if you are using Option A above.
DROPBOX_ACCESS_TOKEN=

# --- Optional ---
# Local Dropbox sync folder. Used by dropbox_download to write files.
# Defaults to ~/Dropbox if unset.
# DROPBOX_LOCAL_PATH=C:\Users\you\Dropbox
```

Two auth modes are supported, tried in order:

1. **OAuth 2 refresh token (recommended):** set `DROPBOX_REFRESH_TOKEN`,
   `DROPBOX_APP_KEY`, and `DROPBOX_APP_SECRET`. Access tokens are refreshed
   automatically, so credentials do not expire.
2. **Legacy long-lived access token (fallback):** set `DROPBOX_ACCESS_TOKEN` only.
   Simpler to get from the app console, but tokens expire after a few hours for
   newer apps.

---

## Running the server

### Directly (for testing)

```bash
python server.py
```

The server communicates over stdio, so there is no interactive output — it waits for
MCP protocol messages on stdin.

### With the MCP Inspector

```bash
npx @modelcontextprotocol/inspector python server.py
```

This opens a browser UI where you can list tools and call them manually.

### Registering with Claude Code

Add an entry to your `~/.claude/.mcp.json`:

```json
{
  "mcpServers": {
    "dropbox": {
      "command": "python",
      "args": [
        "-X", "utf8",
        "C:\\path\\to\\dropbox-mcp\\server.py"
      ]
    }
  }
}
```

The `-X utf8` flag is recommended on Windows so that non-ASCII paths in results do
not trip up the default `cp1252` encoding.

Restart Claude Code for the registration to take effect.

---

## Examples

**Restore a file deleted by accident:**

```
Agent: dropbox_restore(path="/Projects/report-final.docx")
Result: Restored: /Projects/report-final.docx (rev: abc123, size: 45678 bytes)
```

**Find a file without knowing its exact location:**

```
Agent: dropbox_search(query="RSP consciousness paper", max_results=5)
Result: Found 3 results for 'RSP consciousness paper':
      1.25 MB  2026-02-18  /Misc/Philosophy/Beyond the Bat/paper.pdf
      0.31 MB  2026-02-10  /Misc/Philosophy/Beyond the Bat/drafts/outline.md
      ...
```

**Roll back to a specific earlier revision:**

```
Agent: dropbox_list_revisions(path="/report.docx", limit=5)
Agent: dropbox_restore_revision(path="/report.docx", rev="0123abc")
```

---

## Security notes

- The `.env` file holds long-lived credentials — keep it out of version control
  (the default `.gitignore` already excludes `.env` files).
- Restore and download tools are **not** idempotent from the user's perspective:
  they mutate Dropbox state or overwrite local files. Agents should confirm
  intent before invoking them, especially `dropbox_restore_batch`.
- The server binds to no network ports — communication is stdio only, so there is
  no inbound attack surface from the MCP layer itself. The only outbound
  connection is to `api.dropbox.com` via HTTPS.
- Logs go to stderr, never stdout (stdout is reserved for MCP protocol frames).

---

## Development

```bash
# Syntax check
python -m py_compile server.py

# Quick smoke test (lists registered tools)
npx @modelcontextprotocol/inspector python server.py
```

For changes to the tool surface, update both this README and `CHANGELOG.md` in the
same commit.

---

## License

MIT — see [LICENSE](LICENSE).
