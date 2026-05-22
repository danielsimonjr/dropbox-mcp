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

const ENV_PATH = join(homedir(), ".claude", "channels", "dropbox", ".env");

/** Load credentials. Mirrors the Python server's os.environ behaviour:
 *  process.env wins; the ~/.claude/channels/dropbox/.env file fills any gaps. */
export function loadConfig(): DropboxConfig {
  let fileEnv: Record<string, string> = {};
  try {
    fileEnv = parseEnv(readFileSync(ENV_PATH, "utf8"));
  } catch {
    // No .env file — fall through to process.env / defaults.
  }
  const get = (key: string): string | undefined => process.env[key] ?? fileEnv[key];
  return {
    refreshToken: get("DROPBOX_REFRESH_TOKEN") ?? "",
    appKey: get("DROPBOX_APP_KEY") ?? "",
    appSecret: get("DROPBOX_APP_SECRET") ?? "",
    accessToken: get("DROPBOX_ACCESS_TOKEN") ?? "",
    localPath: get("DROPBOX_LOCAL_PATH") ?? join(homedir(), "Dropbox"),
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
