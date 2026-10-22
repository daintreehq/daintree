import { readFile } from "fs/promises";
import os from "os";
import path from "path";

export type ResourceConfigProbe = "none" | "configured" | "unknown";

/** Every key that can declare a resource environment, current or legacy. */
const RESOURCE_KEYS = ["resource", "resources", "resourceEnvironments", "resourceEnvironment"];

/** Mirrors the workspace host's per-project config directory naming. */
function sanitizePathSegment(value: string): string {
  return value.replace(/[/\\:*?"<>|]/g, "_");
}

async function readCandidate(filePath: string): Promise<ResourceConfigProbe> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "ENOENT" ? "none" : "unknown";
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "unknown";
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "unknown";
  const record = parsed as Record<string, unknown>;
  return RESOURCE_KEYS.some((key) => record[key] !== undefined && record[key] !== null)
    ? "configured"
    : "none";
}

/**
 * Whether the project declares a resource environment anywhere the workspace
 * host would load one from: the user's per-project config and settings, the
 * repository's, and each worktree's config.
 *
 * Read here rather than taken from the host's snapshot, whose
 * `hasResourceConfig` is filled in asynchronously after the monitor starts and
 * reads as absent until then — or for good, if that read failed. A file that
 * exists but can't be read or parsed is `unknown`, never `none`.
 */
export async function probeResourceConfig(
  projectRoot: string,
  worktreePaths: readonly string[],
  homeDir: string = os.homedir()
): Promise<ResourceConfigProbe> {
  const userDir = path.join(homeDir, ".daintree", "projects", sanitizePathSegment(projectRoot));
  const candidates = new Set([
    path.join(userDir, "config.json"),
    path.join(userDir, "settings.json"),
    path.join(projectRoot, ".daintree", "config.json"),
    path.join(projectRoot, ".daintree", "settings.json"),
    ...worktreePaths.map((worktreePath) => path.join(worktreePath, ".daintree", "config.json")),
  ]);
  const results = await Promise.all([...candidates].map(readCandidate));
  if (results.includes("configured")) return "configured";
  if (results.includes("unknown")) return "unknown";
  return "none";
}
