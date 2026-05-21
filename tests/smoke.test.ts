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
