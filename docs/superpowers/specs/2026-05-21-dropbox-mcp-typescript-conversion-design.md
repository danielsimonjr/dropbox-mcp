# dropbox-mcp → TypeScript SDK Conversion — Design

**Date:** 2026-05-21
**Status:** Design approved; pending spec review
**Repo:** `C:\Users\danie\Dropbox\Github\dropbox-mcp` (github.com/danielsimonjr/dropbox-mcp)

## Goal

Convert `dropbox-mcp` from Python (FastMCP) to TypeScript on the MCP SDK,
compiled to `dist/`, with **strict 1:1 behavior parity** across all 8 existing
tools.

## Why

The Python `dropbox-mcp` server intermittently fails to connect in Claude Code:
its cold start can exceed the 30 s MCP startup timeout under disk-scan
contention. All Node-based MCP servers in the fleet start fast and connect
reliably. This conversion is server #1 of a 4-server program
(dropbox-mcp → time-mcp → gmail-mcp → Windows-mcp); each server is converted
under its own spec/plan/implementation cycle.

## Non-goals

- No new tools, no removed tools, no changed tool inputs or output formats.
- No change to authentication, credential storage location, or the Dropbox
  account used.
- The other three servers are out of scope (separate specs).

## Current state — parity source of truth

`server.py`, 160 LOC, FastMCP, 8 tools. Authentication loads
`~/.claude/channels/dropbox/.env` on startup and supports two modes, tried in
order: (1) OAuth 2 refresh token — `DROPBOX_REFRESH_TOKEN` + `DROPBOX_APP_KEY` +
`DROPBOX_APP_SECRET`; (2) legacy `DROPBOX_ACCESS_TOKEN`. `DROPBOX_LOCAL_PATH`
(default `~/Dropbox`) sets the local write target for `dropbox_download`.

### The 8 tools (parity table)

| Tool | Inputs | Python SDK call → JS SDK call | Class |
|---|---|---|---|
| `dropbox_restore` | `path` | `files_restore` (after `files_list_revisions`) → `filesRestore` / `filesListRevisions` | destructive |
| `dropbox_restore_batch` | `paths[]` | per-path `files_restore` → `filesRestore` | destructive |
| `dropbox_restore_revision` | `path`, `rev` | `files_restore` → `filesRestore` | destructive |
| `dropbox_download` | `path` | `files_download` → `filesDownload` (Node: `result.fileBinary` Buffer) | destructive |
| `dropbox_search` | `query`, `path=""`, `max_results=20` | `files_search_v2` → `filesSearchV2` | read-only |
| `dropbox_list_deleted` | `path`, `recursive=false` | `files_list_folder(_continue)` → `filesListFolder(Continue)` | read-only |
| `dropbox_file_info` | `path` | `files_get_metadata` → `filesGetMetadata` | read-only |
| `dropbox_list_revisions` | `path`, `limit=10` | `files_list_revisions` → `filesListRevisions` | read-only |

Output strings must match the Python version exactly (see `server.py` and the
examples in `README.md`) — this is the parity contract.

## Target architecture

**Stack:** `@modelcontextprotocol/sdk` (`^1.29`), `zod` (`^4`) for runtime arg
validation, and the official `dropbox` npm SDK (first-party, TS-typed, supports
the same refresh-token and access-token modes). Node 18+ (the Dropbox SDK uses
global `fetch`; pass an explicit `fetch` if the pinned SDK version still
requires it — confirmed during implementation). Real TypeScript compiled with
plain `tsc` to `dist/`.

**SDK API choice:** follow the `memory-mcp` / `math-mcp` pattern — the
lower-level `Server` class, a `TOOLS: Tool[]` array with JSON-schema
`inputSchema`, and dispatch via `setRequestHandler(ListToolsRequestSchema, …)` /
`setRequestHandler(CallToolRequestSchema, …)`. (`gmail-mcp/server.js` uses the
higher-level `McpServer` API; dropbox-mcp deliberately matches the compiled-TS
servers instead, for fleet consistency. **Flagged for spec review.**)

### File layout

```
src/
  index.ts     shebang entry; builds Server, registers ListTools + CallTool
               handlers, connects StdioServerTransport, main()
  dropbox.ts   loadEnv() (parses ~/.claude/channels/dropbox/.env) +
               getClient() (refresh-token → access-token fallback)
  tools.ts     TOOLS[] definitions + the 8 tool handler functions
  format.ts    output-string formatters (the parity contract; primary
               unit-test target)
dist/          tsc output; .mcp.json runs dist/index.js
tsconfig.json  package.json  vitest.config.ts
```

Each file has one job: server wiring / auth+client / tool surface / output
formatting. `format.ts` is isolated because matching the Python output strings
verbatim is the parity contract and the main thing worth unit-testing.

### tsconfig.json (from the memory-mcp / math-mcp pattern)

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

### package.json (key fields)

```json
{
  "name": "dropbox-mcp",
  "version": "0.2.0",
  "type": "module",
  "main": "./dist/index.js",
  "bin": { "dropbox-mcp": "dist/index.js" },
  "files": ["dist"],
  "scripts": {
    "build": "tsc",
    "watch": "tsc --watch",
    "test": "vitest run --coverage",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.29.0",
    "dropbox": "^10",
    "zod": "^4"
  },
  "devDependencies": {
    "@types/node": "^22",
    "@vitest/coverage-v8": "^4",
    "typescript": "^5.9",
    "vitest": "^4"
  }
}
```

Version bumps `0.1.1 → 0.2.0` (full reimplementation, identical tool surface).
Exact dependency versions are pinned during the implementation plan.

## Authentication & config — unchanged

`dropbox.ts` replicates the Python `.env` loader: read
`~/.claude/channels/dropbox/.env`, parse `KEY=VALUE` lines (skip blanks and
`#` comments) into a config object. `getClient()` builds the Dropbox client
with `{ refreshToken, clientId: appKey, clientSecret: appSecret }` when a
refresh token is present, else `{ accessToken }`. The existing `.env` keeps
working as-is — no re-authentication.

## Error handling

Each tool handler wraps its SDK calls in `try/catch`; Dropbox API errors are
returned as a clean text result (`{ isError: true, content: [{ type: "text",
text }] }`), never a thrown stack trace. `dropbox_restore_batch` keeps its
per-path error reporting. All diagnostic logging goes to `console.error`
(stderr) only — stdout is reserved for the MCP protocol channel.

## Tool annotations (approved addition)

Each tool's definition gets MCP annotations the Python version lacked:
`readOnlyHint: true` on the 4 read-only tools (`search`, `list_deleted`,
`file_info`, `list_revisions`); `destructiveHint: true` on the 4 mutating tools
(`restore`, `restore_batch`, `restore_revision`, `download`). Metadata only —
no behavior change.

## Testing

`vitest`, tests in `tests/**/*.test.ts`:
- **Unit:** `format.ts` output strings (every formatter, against strings copied
  from the Python version); the `.env` parser; `getClient()` mode selection
  (refresh-token vs access-token) with the Dropbox SDK mocked.
- **Smoke:** the built server (`dist/index.js`) starts and `ListTools` returns
  exactly the 8 expected tool names.
- Live Dropbox API calls are **not** unit-tested; verified manually via
  `npx @modelcontextprotocol/inspector node dist/index.js`.

## Cutover

1. Implement, build to `dist/`, run unit + smoke tests green.
2. Manually verify all 8 tools via MCP Inspector against the real account.
3. Repoint the `dropbox-mcp` entry in `mcp-host\.mcp.json` from
   `python.exe … server.py` to `node … dist/index.js`.
4. `/reload-plugins`; confirm `dropbox-mcp` connects in `/mcp` with no 30 s
   timeout and tools are callable.
5. Remove `server.py`, `requirements.txt`, `pyproject.toml` in a follow-up
   commit; retire the `.venvs\dropbox-mcp` virtualenv.

`server.py` stays in the repo until step 4 confirms the TS server works.

## Done when

`dropbox-mcp` shows connected in `/mcp` (no cold-start timeout), all 8 tools
are callable, and their outputs match the Python server.

## Risks

- **Dropbox JS SDK shape differs from the Python SDK** — camelCase methods,
  `'.tag'` discriminated unions instead of `isinstance()`, and `filesDownload`
  returning a `fileBinary` Buffer. Mechanical but must be done per tool.
- **`filesSearchV2` result nesting** — the JS SDK represents match metadata
  differently from the Python `match.metadata.get_metadata()`; the search tool
  handler needs care to extract `path_display` / `size` / `server_modified`.
- **`dropbox` SDK / `fetch` coupling** — confirm whether the pinned SDK version
  needs an explicit `fetch` passed on the target Node version.
