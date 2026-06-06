# dropbox-mcp TypeScript Conversion — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: this plan is executed under the
> `dev-workflow` skill, task-by-task. Steps use checkbox (`- [ ]`) syntax for
> tracking. Each task is one atomic commit.

**Goal:** Replace the Python (FastMCP) `dropbox-mcp` server with a TypeScript
implementation on `@modelcontextprotocol/sdk`, compiled to `dist/`, with strict
1:1 behavior parity across all 8 tools — eliminating the Python cold-start
timeout that intermittently blocks the server from connecting in Claude Code.

**Architecture:** Low-level MCP `Server` + a `Tool[]` array dispatched via
`setRequestHandler` (matching `memory-mcp` / `math-mcp`). Four `src/` files:
`dropbox.ts` (config + client), `format.ts` (output strings), `tools.ts`
(`TOOLS[]` + handlers), `index.ts` (server wiring). Build with plain `tsc`.

**Tech Stack:** TypeScript 5.9, `@modelcontextprotocol/sdk` 1.29.0, `dropbox`
10.34.0 (official JS SDK; bundles `node-fetch` — no `fetch` injection needed),
`zod` 4 (handler-side arg validation), `vitest` 4. Node ≥18.

**Design doc:** `docs/superpowers/specs/2026-05-21-dropbox-mcp-typescript-conversion-design.md`

---

## File Structure

| File | Responsibility |
|---|---|
| `src/dropbox.ts` | `parseEnv`, `loadConfig` (reads `~/.claude/channels/dropbox/.env`), `getClient` (refresh-token → access-token), `DropboxConfig` type |
| `src/format.ts` | Pure output-string formatters — the parity contract |
| `src/tools.ts` | `TOOLS: Tool[]` definitions + 8 handler functions + `HANDLERS` dispatch map |
| `src/index.ts` | `Server` construction, `ListTools`/`CallTool` handlers, `StdioServerTransport`, `main()` |
| `tests/*.test.ts` | vitest unit + smoke tests |
| `package.json`, `tsconfig.json`, `vitest.config.ts` | Build/test config |

**Shared types (defined in Task 2, used throughout):**

```typescript
// src/dropbox.ts
export interface DropboxConfig {
  refreshToken: string;
  appKey: string;
  appSecret: string;
  accessToken: string;
  localPath: string;   // resolved download target; defaults to ~/Dropbox
}
// src/tools.ts
export type ToolHandler = (
  client: import("dropbox").Dropbox,
  config: DropboxConfig,
  rawArgs: unknown,
) => Promise<string>;
```

Handlers return a plain `string`; `index.ts` wraps it as
`{ content: [{ type: "text", text }] }`.

---

## Task 1: Scaffold the TypeScript project

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `src/index.ts` (stub)
- Modify: `.gitignore`

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "dropbox-mcp",
  "version": "0.2.0",
  "description": "MCP server exposing Dropbox file recovery, search, and download operations to LLM agents.",
  "type": "module",
  "main": "./dist/index.js",
  "bin": { "dropbox-mcp": "dist/index.js" },
  "files": ["dist"],
  "scripts": {
    "build": "tsc",
    "watch": "tsc --watch",
    "test": "vitest run",
    "test:coverage": "vitest run --coverage",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.29.0",
    "dropbox": "^10.34.0",
    "zod": "^4.4.3"
  },
  "devDependencies": {
    "@types/node": "^22",
    "@vitest/coverage-v8": "^4.1.5",
    "typescript": "^5.9.3",
    "vitest": "^4.1.5"
  }
}
```

- [ ] **Step 2: Write `tsconfig.json`**

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

- [ ] **Step 3: Write `vitest.config.ts`**

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    coverage: { provider: "v8", include: ["src/**/*.ts"] },
  },
});
```

- [ ] **Step 4: Append build artifacts to `.gitignore`**

Append these lines if not already present:

```
node_modules/
dist/
coverage/
```

- [ ] **Step 5: Write the stub `src/index.ts`**

```typescript
#!/usr/bin/env node
// dropbox-mcp — TypeScript MCP server. Implementation lands in Task 7.
console.error("dropbox-mcp: starting");
```

- [ ] **Step 6: Install dependencies**

Run: `npm install`
Expected: completes with no errors; `node_modules/dropbox` and
`node_modules/@modelcontextprotocol/sdk` exist.

- [ ] **Step 7: Verify build and typecheck**

Run: `npm run build`
Expected: exit 0; `dist/index.js` is created.
Run: `npm run typecheck`
Expected: exit 0, no output.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .gitignore src/index.ts
git commit -m "chore(ts): scaffold TypeScript project"
```

---

## Task 2: Config loading and Dropbox client — `src/dropbox.ts`

**Files:**
- Create: `src/dropbox.ts`, `tests/dropbox.test.ts`

**SDK note:** before writing Step 5, confirm the Dropbox client constructor
options against `node_modules/dropbox/types/index.d.ts` (the `DropboxOptions`
type). Expected option names: `accessToken`, `clientId`, `clientSecret`,
`refreshToken`. The TDD RED step will catch a mismatch.

- [ ] **Step 1: Write the failing test for `parseEnv`**

Create `tests/dropbox.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { parseEnv, getClient, type DropboxConfig } from "../src/dropbox.js";

describe("parseEnv", () => {
  it("parses KEY=VALUE lines, skipping blanks and comments", () => {
    const text = [
      "# a comment",
      "",
      "DROPBOX_APP_KEY=abc123",
      "DROPBOX_APP_SECRET = sek ret ",
      "  # indented comment",
      "EMPTY=",
    ].join("\n");
    expect(parseEnv(text)).toEqual({
      DROPBOX_APP_KEY: "abc123",
      DROPBOX_APP_SECRET: "sek ret",
      EMPTY: "",
    });
  });

  it("keeps only the first '=' as the separator", () => {
    expect(parseEnv("TOKEN=a=b=c")).toEqual({ TOKEN: "a=b=c" });
  });
});
```

- [ ] **Step 2: Run the test — confirm RED**

Run: `npx vitest run tests/dropbox.test.ts`
Expected: FAIL — `parseEnv` is not exported / file does not exist.

- [ ] **Step 3: Implement `parseEnv` and the config types in `src/dropbox.ts`**

```typescript
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Dropbox } from "dropbox";

export interface DropboxConfig {
  refreshToken: string;
  appKey: string;
  appSecret: string;
  accessToken: string;
  localPath: string;
}

/** Parse KEY=VALUE lines; ignore blanks and lines whose first non-space char is '#'. */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}
```

- [ ] **Step 4: Run the test — confirm GREEN**

Run: `npx vitest run tests/dropbox.test.ts`
Expected: the two `parseEnv` tests PASS.

- [ ] **Step 5: Add the failing test for `getClient`**

Append to `tests/dropbox.test.ts`:

```typescript
const mockCtor = vi.fn();
vi.mock("dropbox", () => ({
  Dropbox: class { constructor(opts: unknown) { mockCtor(opts); } },
}));

function cfg(over: Partial<DropboxConfig>): DropboxConfig {
  return { refreshToken: "", appKey: "", appSecret: "", accessToken: "", localPath: "/tmp", ...over };
}

describe("getClient", () => {
  it("uses refresh-token mode when a refresh token + app key are present", () => {
    mockCtor.mockClear();
    getClient(cfg({ refreshToken: "rt", appKey: "ak", appSecret: "as" }));
    expect(mockCtor).toHaveBeenCalledWith({
      refreshToken: "rt", clientId: "ak", clientSecret: "as",
    });
  });

  it("falls back to access-token mode when no refresh token", () => {
    mockCtor.mockClear();
    getClient(cfg({ accessToken: "legacy" }));
    expect(mockCtor).toHaveBeenCalledWith({ accessToken: "legacy" });
  });
});
```

- [ ] **Step 6: Run the test — confirm RED**

Run: `npx vitest run tests/dropbox.test.ts`
Expected: FAIL — `getClient` not exported.

- [ ] **Step 7: Implement `loadConfig` and `getClient` in `src/dropbox.ts`**

Append to `src/dropbox.ts`:

```typescript
const ENV_PATH = join(homedir(), ".claude", "channels", "dropbox", ".env");

/** Load credentials from ~/.claude/channels/dropbox/.env (missing file → empty config). */
export function loadConfig(): DropboxConfig {
  let env: Record<string, string> = {};
  try {
    env = parseEnv(readFileSync(ENV_PATH, "utf8"));
  } catch {
    // No .env file — fall through with empty values; getClient will fail clearly.
  }
  return {
    refreshToken: env.DROPBOX_REFRESH_TOKEN ?? "",
    appKey: env.DROPBOX_APP_KEY ?? "",
    appSecret: env.DROPBOX_APP_SECRET ?? "",
    accessToken: env.DROPBOX_ACCESS_TOKEN ?? "",
    localPath: env.DROPBOX_LOCAL_PATH ?? join(homedir(), "Dropbox"),
  };
}

/** Build a Dropbox client: OAuth2 refresh-token mode preferred, legacy access token as fallback. */
export function getClient(config: DropboxConfig): Dropbox {
  if (config.refreshToken && config.appKey) {
    return new Dropbox({
      refreshToken: config.refreshToken,
      clientId: config.appKey,
      clientSecret: config.appSecret,
    });
  }
  return new Dropbox({ accessToken: config.accessToken });
}
```

- [ ] **Step 8: Run the test — confirm GREEN**

Run: `npx vitest run tests/dropbox.test.ts`
Expected: all 4 tests PASS.
Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 9: Commit**

```bash
git add src/dropbox.ts tests/dropbox.test.ts
git commit -m "feat(ts): add config loader and Dropbox client factory"
```

---

## Task 3: Output formatters — `src/format.ts`

The formatters reproduce the Python `server.py` output strings exactly. Test
expectations are copied from the Python implementation.

**Files:**
- Create: `src/format.ts`, `tests/format.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/format.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  padLeft, withCommas, bytesToMb,
  formatSearch, formatListDeleted, formatListRevisions,
} from "../src/format.js";

describe("number helpers", () => {
  it("padLeft right-justifies to a width", () => {
    expect(padLeft("12", 8)).toBe("      12");
  });
  it("withCommas groups thousands", () => {
    expect(withCommas(1234567)).toBe("1,234,567");
  });
  it("bytesToMb rounds to 2 decimals", () => {
    expect(bytesToMb(1572864)).toBe(1.5);
  });
});

describe("formatSearch", () => {
  it("returns a no-results line when empty", () => {
    expect(formatSearch("foo", [])).toBe("No results for 'foo'");
  });
  it("formats matches with right-justified MB, date, path", () => {
    const out = formatSearch("rep", [
      { path: "/a/report.pdf", size_mb: 1.25, modified: "2026-02-18T09:00:00Z" },
    ]);
    expect(out).toBe(
      "Found 1 results for 'rep':\n      1.25 MB  2026-02-18  /a/report.pdf",
    );
  });
});

describe("formatListDeleted", () => {
  it("returns a no-results line when empty", () => {
    expect(formatListDeleted("/x", [])).toBe("No deleted files found in /x");
  });
  it("lists up to 50 entries and notes the overflow", () => {
    const paths = Array.from({ length: 52 }, (_, i) => `/x/f${i}`);
    const out = formatListDeleted("/x", paths);
    expect(out.startsWith("Found 52 deleted files in /x:")).toBe(true);
    expect(out.endsWith("  ... and 2 more")).toBe(true);
  });
});

describe("formatListRevisions", () => {
  it("returns a no-results line when empty", () => {
    expect(formatListRevisions("/r.docx", [])).toBe("No revisions found for /r.docx");
  });
  it("formats rev id, comma-grouped size, and modified date", () => {
    const out = formatListRevisions("/r.docx", [
      { rev: "0abc", size: 1234567, modified: "2026-02-10T00:00:00Z" },
    ]);
    expect(out).toBe(
      "Revisions for /r.docx (1 found):\n  rev: 0abc  size:  1,234,567 bytes  modified: 2026-02-10T00:00:00Z",
    );
  });
});
```

- [ ] **Step 2: Run the tests — confirm RED**

Run: `npx vitest run tests/format.test.ts`
Expected: FAIL — `src/format.ts` does not exist.

- [ ] **Step 3: Implement `src/format.ts`**

```typescript
/** Right-justify `s` to `width` with spaces (Python `{:>width}`). */
export function padLeft(s: string | number, width: number): string {
  return String(s).padStart(width, " ");
}

/** Group integer thousands with commas (Python `{:,}`). */
export function withCommas(n: number): string {
  return n.toLocaleString("en-US");
}

/** Bytes → MB rounded to 2 decimals (Python `round(x, 2)`). */
export function bytesToMb(bytes: number): number {
  return Math.round((bytes / (1024 * 1024)) * 100) / 100;
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

export function formatSearch(query: string, matches: SearchMatch[]): string {
  if (matches.length === 0) return `No results for '${query}'`;
  const lines = [`Found ${matches.length} results for '${query}':`];
  for (const m of matches) {
    lines.push(`  ${padLeft(m.size_mb, 8)} MB  ${m.modified.slice(0, 10)}  ${m.path}`);
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

/** file_info: JSON, 2-space indent (Python json.dumps(indent=2)). */
export function formatFileInfo(obj: Record<string, unknown>): string {
  return JSON.stringify(obj, null, 2);
}
```

- [ ] **Step 4: Run the tests — confirm GREEN**

Run: `npx vitest run tests/format.test.ts`
Expected: all tests PASS.
Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/format.ts tests/format.test.ts
git commit -m "feat(ts): add parity output formatters"
```

---

## Task 4: Tool definitions — `TOOLS[]` in `src/tools.ts`

**Files:**
- Create: `src/tools.ts`, `tests/tools-defs.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/tools-defs.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { TOOLS } from "../src/tools.js";

const READ_ONLY = ["dropbox_search", "dropbox_list_deleted", "dropbox_file_info", "dropbox_list_revisions"];
const DESTRUCTIVE = ["dropbox_restore", "dropbox_restore_batch", "dropbox_restore_revision", "dropbox_download"];

describe("TOOLS", () => {
  it("defines exactly the 8 expected tools", () => {
    expect(TOOLS.map((t) => t.name).sort()).toEqual([...READ_ONLY, ...DESTRUCTIVE].sort());
  });
  it("every tool has a non-empty description and an object input schema", () => {
    for (const t of TOOLS) {
      expect(t.description && t.description.length > 0).toBe(true);
      expect(t.inputSchema.type).toBe("object");
    }
  });
  it("annotates read-only and destructive tools", () => {
    for (const t of TOOLS) {
      if (READ_ONLY.includes(t.name)) expect(t.annotations?.readOnlyHint).toBe(true);
      if (DESTRUCTIVE.includes(t.name)) expect(t.annotations?.destructiveHint).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run the test — confirm RED**

Run: `npx vitest run tests/tools-defs.test.ts`
Expected: FAIL — `src/tools.ts` does not exist.

- [ ] **Step 3: Implement the `TOOLS` array in `src/tools.ts`**

```typescript
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
```

- [ ] **Step 4: Run the test — confirm GREEN**

Run: `npx vitest run tests/tools-defs.test.ts`
Expected: all 3 tests PASS.
Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/tools.ts tests/tools-defs.test.ts
git commit -m "feat(ts): add MCP tool definitions for the 8 dropbox tools"
```

---

## Task 5: Read-only tool handlers — `src/tools.ts`

Handlers for `dropbox_search`, `dropbox_list_deleted`, `dropbox_file_info`,
`dropbox_list_revisions`. Each parses its args with zod, calls the Dropbox SDK,
and returns a formatted string.

**SDK note:** confirm method names and `.result` shapes against
`node_modules/dropbox/types/index.d.ts` before implementing. Expected:
`filesSearchV2({ query, options })`, `filesListFolder({ path, recursive,
include_deleted })`, `filesListFolderContinue({ cursor })`,
`filesGetMetadata({ path })`, `filesListRevisions({ path, limit })` — all
returning `{ result: ... }`. The RED step will surface any mismatch.

**Files:**
- Modify: `src/tools.ts`
- Create: `tests/handlers-readonly.test.ts`

- [ ] **Step 1: Write the failing tests (Dropbox client mocked)**

Create `tests/handlers-readonly.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { HANDLERS } from "../src/tools.js";
import type { DropboxConfig } from "../src/dropbox.js";

const config: DropboxConfig = {
  refreshToken: "", appKey: "", appSecret: "", accessToken: "x", localPath: "/tmp",
};
// Minimal fake client — only the methods each handler calls.
const fake = (methods: Record<string, unknown>) => methods as never;

describe("handleFileInfo", () => {
  it("formats file metadata as indented JSON", async () => {
    const client = fake({
      filesGetMetadata: async () => ({
        result: { ".tag": "file", path_display: "/a.txt", size: 2097152,
          server_modified: "2026-01-01T00:00:00Z", rev: "0r", content_hash: "h" },
      }),
    });
    const out = await HANDLERS["dropbox_file_info"](client, config, { path: "/a.txt" });
    expect(JSON.parse(out)).toEqual({
      path: "/a.txt", size: 2097152, size_mb: 2, modified: "2026-01-01T00:00:00Z",
      rev: "0r", content_hash: "h",
    });
  });
});

describe("handleListRevisions", () => {
  it("formats the revision list", async () => {
    const client = fake({
      filesListRevisions: async () => ({
        result: { entries: [{ rev: "0r", size: 100, server_modified: "2026-01-01T00:00:00Z" }] },
      }),
    });
    const out = await HANDLERS["dropbox_list_revisions"](client, config, { path: "/a.txt" });
    expect(out).toContain("Revisions for /a.txt (1 found):");
    expect(out).toContain("rev: 0r");
  });
});

describe("handleSearch", () => {
  it("maps search matches to formatted lines", async () => {
    const client = fake({
      filesSearchV2: async () => ({
        result: { matches: [{
          metadata: { ".tag": "metadata", metadata: {
            ".tag": "file", path_display: "/a.pdf", size: 1048576,
            server_modified: "2026-02-01T00:00:00Z" } } }] },
      }),
    });
    const out = await HANDLERS["dropbox_search"](client, config, { query: "a" });
    expect(out).toContain("Found 1 results for 'a':");
    expect(out).toContain("/a.pdf");
  });
});

describe("handleListDeleted", () => {
  it("collects DeletedMetadata entries across pagination", async () => {
    let page = 0;
    const client = fake({
      filesListFolder: async () => ({
        result: { entries: [{ ".tag": "deleted", path_display: "/d1" }], has_more: true, cursor: "c" },
      }),
      filesListFolderContinue: async () => {
        page++;
        return { result: { entries: [{ ".tag": "deleted", path_display: "/d2" }], has_more: false, cursor: "" } };
      },
    });
    const out = await HANDLERS["dropbox_list_deleted"](client, config, { path: "/x" });
    expect(out).toContain("Found 2 deleted files in /x:");
    expect(page).toBe(1);
  });
});
```

- [ ] **Step 2: Run the tests — confirm RED**

Run: `npx vitest run tests/handlers-readonly.test.ts`
Expected: FAIL — `HANDLERS` is not exported from `src/tools.ts`.

- [ ] **Step 3: Implement the read-only handlers in `src/tools.ts`**

Append to `src/tools.ts`:

```typescript
import { z } from "zod";
import type { Dropbox } from "dropbox";
import type { DropboxConfig } from "./dropbox.js";
import {
  bytesToMb, formatSearch, formatListDeleted, formatFileInfo, formatListRevisions,
  type SearchMatch,
} from "./format.js";

export type ToolHandler = (client: Dropbox, config: DropboxConfig, rawArgs: unknown) => Promise<string>;

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
    const meta = m.metadata.metadata;
    if (meta[".tag"] === "file") {
      matches.push({
        path: meta.path_display ?? "",
        size_mb: bytesToMb(meta.size),
        modified: meta.server_modified ?? "unknown",
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
      modified: meta.server_modified ?? null,
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
      rev: e.rev, size: e.size, modified: e.server_modified ?? "unknown",
    })),
  );
}
```

> Note: tighten the `meta`/`entry` types using the Dropbox `files.*` exported
> types if `strict` flags an `any`; the `'.tag'` narrowing above is the
> intended pattern.

- [ ] **Step 4: Add the `HANDLERS` map (read-only entries only for now)**

Append to `src/tools.ts`:

```typescript
export const HANDLERS: Record<string, ToolHandler> = {
  dropbox_search: handleSearch,
  dropbox_list_deleted: handleListDeleted,
  dropbox_file_info: handleFileInfo,
  dropbox_list_revisions: handleListRevisions,
};
```

- [ ] **Step 5: Run the tests — confirm GREEN**

Run: `npx vitest run tests/handlers-readonly.test.ts`
Expected: all 4 tests PASS.
Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/tools.ts tests/handlers-readonly.test.ts
git commit -m "feat(ts): add read-only dropbox tool handlers"
```

---

## Task 6: Mutating tool handlers — `src/tools.ts`

Handlers for `dropbox_restore`, `dropbox_restore_batch`,
`dropbox_restore_revision`, `dropbox_download`.

**SDK note:** confirm against the installed `.d.ts`: `filesRestore({ path,
rev })` → `{ result: FileMetadata }`; `filesDownload({ path })` → `{ result }`
where the result carries `fileBinary` (a `Buffer`) on Node and `size`.

**Files:**
- Modify: `src/tools.ts`
- Create: `tests/handlers-mutating.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/handlers-mutating.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { HANDLERS } from "../src/tools.js";
import type { DropboxConfig } from "../src/dropbox.js";

vi.mock("node:fs", () => ({
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

const config: DropboxConfig = {
  refreshToken: "", appKey: "", appSecret: "", accessToken: "x", localPath: "/tmp/dbx",
};
const fake = (m: Record<string, unknown>) => m as never;

describe("handleRestore", () => {
  it("restores the most recent revision and reports it", async () => {
    const client = fake({
      filesListRevisions: async () => ({ result: { entries: [{ rev: "0r" }] } }),
      filesRestore: async () => ({ result: { size: 4096 } }),
    });
    const out = await HANDLERS["dropbox_restore"](client, config, { path: "/a.txt" });
    expect(out).toBe("Restored: /a.txt (rev: 0r, size: 4096 bytes)");
  });
  it("reports when no revisions exist", async () => {
    const client = fake({ filesListRevisions: async () => ({ result: { entries: [] } }) });
    const out = await HANDLERS["dropbox_restore"](client, config, { path: "/a.txt" });
    expect(out).toBe("No revisions found for /a.txt");
  });
});

describe("handleRestoreBatch", () => {
  it("reports per-path results and a total", async () => {
    const client = fake({
      filesListRevisions: async ({ path }: { path: string }) =>
        path === "/ok" ? { result: { entries: [{ rev: "0r" }] } } : { result: { entries: [] } },
      filesRestore: async () => ({ result: { size: 1 } }),
    });
    const out = await HANDLERS["dropbox_restore_batch"](client, config, { paths: ["/ok", "/none"] });
    expect(out).toContain("  RESTORED: /ok");
    expect(out).toContain("  NO REVISIONS: /none");
    expect(out).toContain("Restored: 1/2");
  });
});

describe("handleRestoreRevision", () => {
  it("restores a specific revision", async () => {
    const client = fake({ filesRestore: async () => ({ result: { size: 9 } }) });
    const out = await HANDLERS["dropbox_restore_revision"](client, config, { path: "/a", rev: "0r" });
    expect(out).toBe("Restored: /a to revision 0r (9 bytes)");
  });
});

describe("handleDownload", () => {
  it("writes the file locally and reports the path", async () => {
    const client = fake({
      filesDownload: async () => ({ result: { size: 12, fileBinary: Buffer.from("hello world!") } }),
    });
    const out = await HANDLERS["dropbox_download"](client, config, { path: "/sub/a.txt" });
    expect(out).toContain("Downloaded: /sub/a.txt -> ");
    expect(out).toContain("(12 bytes)");
  });
});
```

- [ ] **Step 2: Run the tests — confirm RED**

Run: `npx vitest run tests/handlers-mutating.test.ts`
Expected: FAIL — these tool names are not in `HANDLERS`.

- [ ] **Step 3: Implement the mutating handlers in `src/tools.ts`**

Add the imports at the top of `src/tools.ts`:

```typescript
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { formatRestore, formatRestoreBatch, formatRestoreRevision, formatDownload } from "./format.js";
```

Append the handlers:

```typescript
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
  // On Node the download payload carries `fileBinary` (a Buffer).
  const data = (res.result as { fileBinary: Buffer }).fileBinary;
  writeFileSync(localPath, data);
  return formatDownload(path, localPath, (res.result as { size: number }).size);
}
```

- [ ] **Step 4: Extend the `HANDLERS` map**

Add these four entries to the `HANDLERS` object literal in `src/tools.ts`:

```typescript
  dropbox_restore: handleRestore,
  dropbox_restore_batch: handleRestoreBatch,
  dropbox_restore_revision: handleRestoreRevision,
  dropbox_download: handleDownload,
```

- [ ] **Step 5: Run the tests — confirm GREEN**

Run: `npx vitest run tests/handlers-mutating.test.ts`
Expected: all tests PASS.
Run: `npx vitest run` (full suite — confirm Tasks 2-6 all green)
Expected: all tests PASS.
Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/tools.ts tests/handlers-mutating.test.ts
git commit -m "feat(ts): add mutating dropbox tool handlers"
```

---

## Task 7: Server wiring — `src/index.ts`

**Files:**
- Modify: `src/index.ts` (replace the Task 1 stub)
- Create: `tests/smoke.test.ts`

- [ ] **Step 1: Write the failing smoke test**

Create `tests/smoke.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { TOOLS, HANDLERS } from "../src/tools.js";

describe("server surface", () => {
  it("every TOOLS entry has a HANDLERS entry and vice versa", () => {
    expect(Object.keys(HANDLERS).sort()).toEqual(TOOLS.map((t) => t.name).sort());
  });
  it("registers exactly 8 tools", () => {
    expect(TOOLS).toHaveLength(8);
  });
});
```

- [ ] **Step 2: Run the test — confirm RED then GREEN**

Run: `npx vitest run tests/smoke.test.ts`
Expected: PASS if Tasks 4-6 are complete (this test guards the
TOOLS↔HANDLERS contract). If it FAILS, a tool name is mismatched — fix `tools.ts`.

- [ ] **Step 3: Implement `src/index.ts`**

```typescript
#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig, getClient } from "./dropbox.js";
import { TOOLS, HANDLERS } from "./tools.js";

const config = loadConfig();
const client = getClient(config);

const server = new Server(
  { name: "dropbox_mcp", version: "0.2.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const handler = HANDLERS[name];
  if (!handler) {
    return { isError: true, content: [{ type: "text", text: `Unknown tool: ${name}` }] };
  }
  try {
    const text = await handler(client, config, args ?? {});
    return { content: [{ type: "text", text }] };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { isError: true, content: [{ type: "text", text: `Error in ${name}: ${msg}` }] };
  }
});

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("dropbox-mcp: connected on stdio");
}

main().catch((e) => {
  console.error("dropbox-mcp: fatal:", e);
  process.exit(1);
});
```

- [ ] **Step 4: Verify build, typecheck, full test suite**

Run: `npm run build`
Expected: exit 0; `dist/index.js`, `dist/tools.js`, `dist/format.js`, `dist/dropbox.js` exist.
Run: `npm run typecheck`
Expected: exit 0.
Run: `npx vitest run`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts tests/smoke.test.ts
git commit -m "feat(ts): wire MCP server, tool dispatch, and stdio transport"
```

---

## Task 8: Manual verification with the MCP Inspector

This task produces no commit — it is a verification gate before cutover.

- [ ] **Step 1: Confirm the build is current**

Run: `npm run build`
Expected: exit 0.

- [ ] **Step 2: Launch the Inspector against the built server**

Run: `npx @modelcontextprotocol/inspector node dist/index.js`
Expected: a browser UI opens; the server connects.

- [ ] **Step 3: Verify the tool list**

In the Inspector, list tools. Expected: exactly 8 tools, names matching the
Python server; the 4 restore/download tools show the destructive annotation.

- [ ] **Step 4: Exercise the read-only tools against the real account**

Call `dropbox_search` (a known query), `dropbox_file_info` (a known path),
`dropbox_list_revisions`, and `dropbox_list_deleted`. Expected: results in the
same string format as the Python server. If auth fails, confirm
`~/.claude/channels/dropbox/.env` is populated.

- [ ] **Step 5: Spot-check one mutating tool**

Call `dropbox_list_revisions` on a file, then `dropbox_restore_revision` with a
known rev (or `dropbox_download` on a small cloud-only file). Expected: the
operation succeeds and the output matches the Python format.

- [ ] **Step 6: Record the result**

If all tools behave correctly, proceed to Task 9. If not, return to the
relevant task — do not cut over a broken server.

---

## Task 9: Cutover — repoint Claude Code at the TypeScript server

**Files:**
- Modify: `C:\Users\danie\.claude\local-marketplace\mcp-host\.mcp.json`

- [ ] **Step 1: Back up the MCP config**

```powershell
Copy-Item "C:\Users\danie\.claude\local-marketplace\mcp-host\.mcp.json" `
  "C:\Users\danie\.claude\local-marketplace\mcp-host\.mcp.json.bak-2026-05-21"
```

- [ ] **Step 2: Repoint the `dropbox-mcp` entry**

In `mcp-host\.mcp.json`, change the `dropbox-mcp` server's `command` and `args`
from the Python launch to:

```json
"dropbox-mcp": {
  "command": "node",
  "args": ["C:/Users/danie/Dropbox/Github/dropbox-mcp/dist/index.js"]
}
```

Preserve any existing `env` block as-is. Validate the JSON:

```powershell
python -c "import json; json.load(open(r'C:\Users\danie\.claude\local-marketplace\mcp-host\.mcp.json'))"
```

Expected: no output (valid JSON).

- [ ] **Step 3: Reload plugins**

The user runs `/reload-plugins` in Claude Code. (If the per-session failure
cache from `feedback_claude_code_mcp_failure_cache.md` interferes, add a unique
`_RETRY` value to the entry's `env` and reload again.)

- [ ] **Step 4: Verify the server is connected**

The user runs `/mcp`. Expected: `dropbox-mcp` shows connected — **no 30 s
timeout** — and its 8 tools are listed. This is the core success criterion of
the conversion.

- [ ] **Step 5: Commit (repo side — none)**

The `.mcp.json` change is outside the repo. No repo commit for this task; the
cutover is recorded in the CHANGELOG in Task 10.

---

## Task 10: Cleanup — retire the Python implementation

**Files:**
- Delete: `server.py`, `requirements.txt`, `pyproject.toml`
- Modify: `README.md`, `CHANGELOG.md`

- [ ] **Step 1: Remove the Python source**

```bash
git rm server.py requirements.txt pyproject.toml
```

- [ ] **Step 2: Update `README.md`**

Replace the Installation, Authentication-unchanged, and Running sections to
describe the TypeScript build: prerequisites Node ≥18; `npm install && npm run
build`; the `.mcp.json` entry uses `node .../dist/index.js`. Keep the Tools
table and Authentication credential template unchanged (auth is identical).

- [ ] **Step 3: Update `CHANGELOG.md`**

Add under a new `## [0.2.0] - 2026-05-21` heading, Keep-a-Changelog style:

```markdown
## [0.2.0] - 2026-05-21

### Changed
- Reimplemented the server in TypeScript on `@modelcontextprotocol/sdk`
  (compiled to `dist/`), replacing the Python/FastMCP implementation. This
  eliminates the cold-start timeout that intermittently prevented the server
  from connecting in Claude Code. All 8 tools retain identical behavior and
  output formatting.

### Added
- `readOnlyHint` / `destructiveHint` MCP annotations on each tool.

### Removed
- `server.py`, `requirements.txt`, `pyproject.toml` (Python implementation).
```

- [ ] **Step 4: Verify nothing references the deleted files**

Run: `npm run build && npm run typecheck && npx vitest run`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore(ts): retire Python implementation; update docs for 0.2.0"
```

- [ ] **Step 6: Retire the Python virtualenv**

```powershell
Remove-Item -Recurse -Force "C:\Users\danie\.venvs\dropbox-mcp"
```

This is the final step — `dropbox-mcp` is now fully on TypeScript.

---

## Self-Review

**1. Spec coverage** — every design-doc section maps to a task: stack/structure
→ Tasks 1-7; auth unchanged → Task 2; the 8 tools → Tasks 4-6; error handling →
Tasks 5-7; tool annotations → Task 4; testing → Tasks 2-7; cutover → Task 9;
done-criteria → Task 9 Step 4; cleanup → Task 10. No gaps.

**2. Placeholder scan** — no "TBD"/"handle edge cases"/vague steps. The two
"SDK note" callouts (Tasks 2, 5, 6) instruct verifying the Dropbox SDK API
against the installed `.d.ts`; this is a concrete action, and the TDD RED step
independently catches any signature mismatch.

**3. Type consistency** — `DropboxConfig` (5 fields) is defined in Task 2 and
used unchanged in Tasks 5-7. `ToolHandler` is defined in Task 5 and reused in
Task 6. `HANDLERS` is created in Task 5 (4 entries) and extended in Task 6 (4
more) → 8 total, asserted in Task 7's smoke test. Formatter names
(`formatRestore`, `formatSearch`, …) are defined in Task 3 and imported by the
exact same names in Tasks 5-6. Tool names are identical across Tasks 4, 5, 6,
and the Task 7 contract test.
