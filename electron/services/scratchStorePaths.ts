import path from "path";
import { app } from "electron";

const STATE_FILENAME = "state.json";

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidScratchId(scratchId: string): boolean {
  return typeof scratchId === "string" && UUID_V4_REGEX.test(scratchId);
}

/**
 * Lazily compute the scratches root under userData. Must only be called after
 * `app.isReady()` — see lesson #1333 (never derive from `process.cwd()`).
 */
export function getScratchesRoot(): string {
  return path.join(app.getPath("userData"), "scratches");
}

export function getScratchDir(scratchesRoot: string, scratchId: string): string | null {
  if (!isValidScratchId(scratchId)) return null;
  const normalizedRoot = path.normalize(scratchesRoot);
  const candidate = path.normalize(path.join(normalizedRoot, scratchId));
  if (!candidate.startsWith(normalizedRoot + path.sep)) return null;
  return candidate;
}

export function scratchStateFilePath(scratchesRoot: string, scratchId: string): string | null {
  const dir = getScratchDir(scratchesRoot, scratchId);
  if (!dir) return null;
  return path.join(dir, STATE_FILENAME);
}
