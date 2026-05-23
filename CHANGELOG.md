# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-05-21

### Changed
- **Rewrote in TypeScript** on `@modelcontextprotocol/sdk` and the official `dropbox` npm SDK. Python `server.py` retired. Invocation changes from `python server.py` to `node dist/index.js`. Tool surface and JSON output are unchanged (strict 1:1 behavior parity with `0.1.x`).
- `loadConfig` now reads `process.env` first and falls back to the `~/.claude/channels/dropbox/.env` file, matching Python's `os.environ` semantics. The MCP host can now inject `DROPBOX_*` env vars via `.mcp.json` and override the file.

### Fixed
- `handleSearch` now strips the trailing `Z` from `server_modified` timestamps so the internal `SearchMatch.modified` field matches Python's naive-datetime `isoformat()` (consistent with `handleFileInfo` and `handleListRevisions`). Not observable in current output because `formatSearch` only displays the date portion, but removes a latent parity bug.

### Removed
- `server.py`, `pyproject.toml`, `requirements.txt` (replaced by `src/`, `package.json`, `tsconfig.json`).

## [0.1.1] - 2026-04-23

### Changed
- Server-reported FastMCP name is now `dropbox_mcp` (was `dropbox`) to match
  the `{service}_mcp` naming convention from the MCP Python guide. This does
  not affect the client-side `.mcp.json` alias, which can still be any name
  the user prefers.

## [0.1.0] - 2026-04-23

Initial public release.

### Added
- FastMCP-based server (`server.py`) exposing 8 Dropbox tools over stdio:
  `dropbox_restore`, `dropbox_restore_batch`, `dropbox_restore_revision`,
  `dropbox_download`, `dropbox_search`, `dropbox_list_deleted`,
  `dropbox_file_info`, `dropbox_list_revisions`.
- OAuth 2 refresh-token auth with legacy access-token fallback.
- Env-file loader reading `~/.claude/channels/dropbox/.env` at startup.
- `pyproject.toml` with `mcp>=1.0.0` and `dropbox>=12.0.0` dependencies.
- `README.md` covering installation, auth (with inline env template),
  registration, examples, and security notes.
- MIT license.
