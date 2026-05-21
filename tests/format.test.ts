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
