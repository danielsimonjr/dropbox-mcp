import { describe, it, expect, vi } from "vitest";
import { HANDLERS } from "../src/tools.js";
import type { DropboxConfig } from "../src/dropbox.js";

vi.mock("node:fs", async (importActual) => {
  const actual = await importActual<typeof import("node:fs")>();
  return { ...actual, mkdirSync: vi.fn(), writeFileSync: vi.fn() };
});

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
