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
