import { describe, it, expect } from "vitest";
import { HANDLERS } from "../src/tools.js";
import type { DropboxConfig } from "../src/dropbox.js";

const config: DropboxConfig = {
  refreshToken: "", appKey: "", appSecret: "", accessToken: "x", localPath: "/tmp",
};
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
