import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { parseEnv, getClient, loadConfig, type DropboxConfig } from "../src/dropbox.js";

const mockCtor = vi.fn();
vi.mock("dropbox", () => ({
  Dropbox: class { constructor(opts: unknown) { mockCtor(opts); } },
}));

vi.mock("node:fs", async (importActual) => {
  const actual = await importActual<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn() };
});

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

  it("uses access-token mode when a refresh token is set but the app key is missing", () => {
    mockCtor.mockClear();
    getClient(cfg({ refreshToken: "rt", accessToken: "legacy" }));
    expect(mockCtor).toHaveBeenCalledWith({ accessToken: "legacy" });
  });
});

describe("loadConfig", () => {
  it("returns empty credentials and a default localPath when .env is missing", () => {
    vi.mocked(readFileSync).mockImplementation(() => {
      const err = new Error("ENOENT: no such file") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    });
    const c = loadConfig();
    expect(c.refreshToken).toBe("");
    expect(c.appKey).toBe("");
    expect(c.appSecret).toBe("");
    expect(c.accessToken).toBe("");
    expect(c.localPath.endsWith("Dropbox")).toBe(true);
  });

  it("maps .env keys onto the config fields", () => {
    vi.mocked(readFileSync).mockImplementation(() =>
      [
        "DROPBOX_REFRESH_TOKEN=rt",
        "DROPBOX_APP_KEY=ak",
        "DROPBOX_APP_SECRET=as",
        "DROPBOX_ACCESS_TOKEN=at",
        "DROPBOX_LOCAL_PATH=D:\\DropboxCustom",
      ].join("\n"),
    );
    expect(loadConfig()).toEqual({
      refreshToken: "rt", appKey: "ak", appSecret: "as",
      accessToken: "at", localPath: "D:\\DropboxCustom",
    });
  });
});
