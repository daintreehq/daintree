import { readFile } from "node:fs/promises";
import path from "node:path";

/** Where `bd connect` records the serve a workspace talks to. Its `url` carries no token. */
export const TARGET_FILE = path.join(".beads", "http_target.json");

/**
 * Normalize a server address to the root `/v0` routes are appended to, or
 * `null` when it can't be one. A path is kept (a serve behind a proxy mount);
 * credentials, queries and fragments aren't: the token travels in a header.
 */
export function normalizeServerUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!url.hostname || url.username || url.password || url.search || url.hash) return null;
  const pathname = url.pathname.replace(/\/+$/, "");
  return `${url.protocol}//${url.host}${pathname}`;
}

async function readTargetFileUrl(projectPath: string): Promise<string | null> {
  let raw: string;
  try {
    raw = await readFile(path.join(projectPath, TARGET_FILE), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as { url?: unknown } | null;
    return normalizeServerUrl(parsed?.url);
  } catch {
    return null;
  }
}

export interface ServerTarget {
  url: string;
  /** Whether the address is one the user chose, which decides if the token may go to it. */
  source: "setting" | "file";
}

const LOOPBACK_HOSTS = new Set(["localhost", "[::1]", "::1"]);

/** A loopback address can only reach this machine, whoever wrote it down. */
export function isLoopbackUrl(serverUrl: string): boolean {
  let host: string;
  try {
    host = new URL(serverUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  return (
    LOOPBACK_HOSTS.has(host) || host.endsWith(".localhost") || /^127(\.\d{1,3}){3}$/.test(host)
  );
}

/**
 * The server a project's beads come from: its `serverUrl` project setting, or
 * else the address `bd connect` wrote into its `.beads/`. A setting that is
 * set but isn't a usable address is refused rather than quietly replaced by
 * the file, so a typo can't point the project at another server.
 */
export async function resolveServerUrl(
  projectPath: string,
  settingValue: string | undefined
): Promise<ServerTarget | null> {
  if (settingValue !== undefined && settingValue.trim() !== "") {
    const fromSetting = normalizeServerUrl(settingValue);
    if (!fromSetting) {
      throw new Error(
        `The Beads server URL "${settingValue.trim()}" isn't an http(s) address. Fix it in Project settings.`
      );
    }
    return { url: fromSetting, source: "setting" };
  }
  const fromFile = await readTargetFileUrl(projectPath);
  return fromFile ? { url: fromFile, source: "file" } : null;
}
