import { describe, it, expect, vi } from "vitest";
import { HANDLERS } from "../src/tools.js";
import type { DropboxConfig } from "../src/dropbox.js";

vi.mock("node:fs", async (importActual) => {
  const actual = await importActual<typeof import("node:fs")>();
  return {
    ...actual,
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    readFileSync: vi.fn(() => Buffer.from("file contents")),
  };
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

describe("handleUpload", () => {
  it("uploads a file and reports size + mode", async () => {
    const client = fake({
      filesUpload: async () => ({ result: { path_display: "/sub/a.txt", size: 13 } }),
    });
    const out = await HANDLERS["dropbox_upload"](client, config, { path: "/sub/a.txt" });
    expect(out).toBe("Uploaded: /sub/a.txt (13 bytes, mode: add)");
  });
  it("passes the requested write mode through", async () => {
    const seen: Record<string, unknown> = {};
    const client = fake({
      filesUpload: async (args: Record<string, unknown>) => {
        Object.assign(seen, args);
        return { result: { path_display: "/a.txt", size: 13 } };
      },
    });
    const out = await HANDLERS["dropbox_upload"](client, config, { path: "/a.txt", mode: "overwrite" });
    expect((seen.mode as { ".tag": string })[".tag"]).toBe("overwrite");
    expect(out).toContain("mode: overwrite");
  });
  it("translates an add-mode 409 conflict into an actionable message", async () => {
    const client = fake({
      filesUpload: async () => {
        const err = new Error("Response failed with a 409 code") as Error & { status: number };
        err.status = 409;
        throw err;
      },
    });
    await expect(
      HANDLERS["dropbox_upload"](client, config, { path: "/a.txt" }),
    ).rejects.toThrow(/Destination already exists.*mode="overwrite"/s);
  });
  it("does not swallow non-conflict upload errors", async () => {
    const client = fake({
      filesUpload: async () => {
        throw new Error("network down");
      },
    });
    await expect(
      HANDLERS["dropbox_upload"](client, config, { path: "/a.txt" }),
    ).rejects.toThrow(/network down/);
  });
});

describe("handleMove", () => {
  it("moves a file and reports from -> to", async () => {
    const client = fake({
      filesMoveV2: async () => ({ result: { metadata: { path_display: "/B/a.txt" } } }),
    });
    const out = await HANDLERS["dropbox_move"](client, config, { from_path: "/A/a.txt", to_path: "/B/a.txt" });
    expect(out).toBe("Moved: /A/a.txt -> /B/a.txt");
  });
});

describe("handleDelete", () => {
  it("deletes a path and notes recoverability", async () => {
    const client = fake({
      filesDeleteV2: async () => ({ result: { metadata: { path_display: "/A/a.txt" } } }),
    });
    const out = await HANDLERS["dropbox_delete"](client, config, { path: "/A/a.txt" });
    expect(out).toContain("Deleted: /A/a.txt");
    expect(out).toContain("recoverable via dropbox_restore");
  });
});
