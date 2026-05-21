import { describe, it, expect } from "vitest";
import {
  padLeft, withCommas, bytesToMb, pyFloat,
  formatSearch, formatListDeleted, formatListRevisions,
  formatFileInfo, formatRestoreBatch,
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

describe("pyFloat", () => {
  it("renders whole numbers with a trailing .0", () => {
    expect(pyFloat(1)).toBe("1.0");
    expect(pyFloat(2)).toBe("2.0");
  });
  it("renders fractional numbers as-is", () => {
    expect(pyFloat(1.25)).toBe("1.25");
    expect(pyFloat(1.5)).toBe("1.5");
  });
});

describe("formatSearch whole-MB parity", () => {
  it("renders a whole-MB size with .0", () => {
    const out = formatSearch("q", [
      { path: "/f", size_mb: 1, modified: "2026-01-01T00:00:00Z" },
    ]);
    expect(out).toBe("Found 1 results for 'q':\n       1.0 MB  2026-01-01  /f");
  });
});

describe("formatFileInfo", () => {
  it("renders a whole-number size_mb as a Python-style float", () => {
    const out = formatFileInfo({ path: "/f", size: 2097152, size_mb: 2, rev: "0r" });
    expect(out).toContain('"size_mb": 2.0');
  });
  it("renders a fractional size_mb normally", () => {
    expect(formatFileInfo({ path: "/f", size_mb: 1.25 })).toContain('"size_mb": 1.25');
  });
  it("handles objects without size_mb (folder case)", () => {
    expect(formatFileInfo({ path: "/d", type: "folder" })).toBe(
      '{\n  "path": "/d",\n  "type": "folder"\n}',
    );
  });
});

describe("formatRestoreBatch", () => {
  it("joins per-path lines and appends a blank-line-separated total", () => {
    const out = formatRestoreBatch(["  RESTORED: /a", "  NO REVISIONS: /b"], 1, 2);
    expect(out).toBe("  RESTORED: /a\n  NO REVISIONS: /b\n\nRestored: 1/2");
  });
});
