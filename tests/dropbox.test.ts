import { describe, it, expect, vi } from "vitest";
import { parseEnv, getClient, type DropboxConfig } from "../src/dropbox.js";

const mockCtor = vi.fn();
vi.mock("dropbox", () => ({
  Dropbox: class { constructor(opts: unknown) { mockCtor(opts); } },
}));

function cfg(over: Partial<DropboxConfig>): DropboxConfig {
  return { refreshToken: "", appKey: "", appSecret: "", accessToken: "", localPath: "/tmp", ...over };
}

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
