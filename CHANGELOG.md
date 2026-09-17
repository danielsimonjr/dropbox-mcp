# Changelog

## [0.6.0] - 2026-09-17

### Changed

- **The plugin now lives in `plugin/`.** The marketplace entry installed the whole
  repository root. The root carries `package.json` and `bun.lock`, so Claude Code's
  installer ran `bun install --frozen-lockfile --ignore-scripts` on every install, and
  the cached plugin held **105.9 MB** of `node_modules` (107.2 MB total) - typescript,
  vitest, esbuild and the coverage stack, none of which the shipped server runs. The installer has no omit-dev
  option, so the only fix is to install a directory that has no lockfile.

  `plugin/` now holds `.claude-plugin/plugin.json`, `.mcp.json`, `bundle/` and `skills/`
  and NOTHING else - no `package.json`, no lockfile. The repository root keeps its own
  `package.json` and `bun.lock` for development, and `scripts/bundle.mjs` writes to
  `plugin/bundle/index.mjs`. The marketplace entry must become `git-subdir` with
  `path: "plugin"`.

  `bundle/index.mjs` is fully self-contained: it has **zero runtime externals**. Verified
  by copying `plugin/` alone into an empty directory (no `node_modules` and no
  `package.json` anywhere above it) and driving the real server over stdio - `initialize`
  and `tools/list` succeed and return **11 tools**, the same 11 that `src/tools.ts`
  defines. Repeated with every non-builtin `import` and `require` denied by a loader hook:
  same result, zero denials. The guard is failure-capable - a control server doing
  `require("typescript")` fails under it with `DENIED_EXTERNAL_REQUIRE: typescript`.

### Changed

- **`scripts/bundle.mjs` now writes to `plugin/bundle/index.mjs`, and only that.** This
  branch was cut before `7657116` and independently added its own bundler to fix the same
  defect - `bundle/index.mjs` was a committed artifact with no build, and it had drifted to
  reporting `0.3.2` while `src/index.ts` said `0.4.0`. `main` fixed it first and fixed it
  better: root-anchored `join(root, ...)` paths, the recovered-flags rationale, and the
  load-bearing `createRequire` banner documented as such. **`main`'s version is kept in
  full** and this branch changes one line of it - the output path - plus the header comment
  and the console line that name it. The duplicate `src/index.ts` version-injection this
  branch carried was dropped for the same reason: `main` already has it, with a better
  comment.

  Two consecutive rebuilds from the synced `src` are byte-identical
  (`dd9b9beeec43d27f9cab4232f62020e138898c8580c37f134e65dc032bddff8c`), compared as
  `git show HEAD:plugin/bundle/index.mjs | sha256sum` rather than by hashing the working
  copy - on this machine git converts LF to CRLF on checkout, so a worktree hash can never
  equal the committed blob and every such comparison reads as "stale".

### Fixed

- **A protocol test asserted a version the SDK never offers, and `main` was RED.**
  `tests/protocol.test.ts` pinned `2026-07-28` and then asserted the negotiated
  version equalled that pin, so it failed with "the server did not offer pinned
  protocol version". It now opens an UNPINNED client and asserts against
  `LATEST_PROTOCOL_VERSION`, so it tracks what the SDK actually speaks.

- **Corrected the `2026-07-28` claim in README and the previous CHANGELOG entry.**
  Verified by probing the built `dist/index.js` over stdio: `negotiated: 2025-11-25`,
  11 tools. The package major and the protocol version are separate facts.

### Changed

- **Bun pinned to 1.4.2** in `packageManager`, `engines.bun` and the CI workflow --
  all three together, since a manifest pin CI does not honour describes an install
  nobody performs.

### Changed

- **Bun toolchain for TypeScript development.** Install and scripts use Bun
  (`bun install`, `bun run …`); `packageManager` / `engines` declare Bun ≥1.4 and
  Node ≥24. Node remains the MCP server runtime — the Claude Code plugin still
  launches `node …/bundle/index.mjs`. Docs and the `bundle` script no longer
  assume npm/Node for the toolchain.

- **MCP SDK v2 (package major).** Upgraded from
  `@modelcontextprotocol/sdk` v1 to `@modelcontextprotocol/server` v2 and replaced
  the hand-wired `server.connect(StdioServerTransport)` entry with `serveStdio`, which
  negotiates the connection era on open. The server speaks the stateless 2025-11-25
  revision (per-request `_meta`, `server/discover`, no `initialize` handshake) while
  still serving legacy 2025-era clients on the same stdio transport. Added protocol
  integration tests that verify modern-era negotiation and tool listing.

### Security (2026-08-04)

Lock-only via `npm update`; no manifest changed. Transitive dependencies of the
MCP SDK / server stack:

- `ip-address` -> 10.4.0 (1 high + 2 medium; needed 10.3.1)
- `hono` -> 4.13.0 (medium; needed 4.12.34)
- `fast-uri` -> 3.1.5 (high; needed 3.1.5)

Only the packages present in this repo's tree are listed above by the resolver;
`npm audit` reports 0 vulnerabilities. Verified with `npm ci` plus this repo's
own build and test scripts.


### Added

- **Windows CI leg.** CI ran on `ubuntu-latest` only — but Windows is the *production*
  platform for this MCP server (it runs on the user's Windows box), so CI had never once
  tested the OS the server actually ships on. The `build` job now runs a
  `[ubuntu-latest, windows-latest]` matrix.


All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] - 2026-07-03

### Added
- The `dropbox` skill now ships inside this plugin (`skills/dropbox/`): bulk
  cloud↔local sync, loose-file sorting, dedup reconciliation, .dropboxignore
  recipes — including its 5 Python orchestration scripts, which remain
  scripts by design (complementary to the MCP tools, not redundant).

### Note
- `bundle/index.mjs` is unchanged (built at 0.3.2); its internal ctor version
  string lags plugin.json intentionally — no server-code changes in 0.4.0.

## [0.3.2] - 2026-06-26

### Security
- **Path traversal hardening.** `dropbox_download` and `dropbox_upload` derived a local file path with `join(config.localPath, path.replace(/^\/+/, ""))`, which only stripped leading slashes — a Dropbox path like `/../../etc/passwd` escaped the sync root and could read/write arbitrary disk locations. Both now resolve through `resolveLocalPath`, which rejects any path that escapes `config.localPath` (covers `..` segments and the Windows cross-drive case). The explicit `local_path` upload override is unchanged. Covered by new tests in `tests/handlers-mutating.test.ts`.

## [0.3.1] - 2026-06-08

### Changed
- `dropbox_upload` returns a friendlier, actionable message on an add-mode write conflict (HTTP 409), pointing to `mode="overwrite"`.

## [0.3.0] - 2026-06-08

### Added
- Atomic mutating tools: `dropbox_upload`, `dropbox_move`, `dropbox_delete`.

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
