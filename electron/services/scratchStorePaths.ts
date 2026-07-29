import path from "path";
import { app } from "electron";
import { isValidScratchStateId } from "./projectStorePaths.js";

export function isValidScratchId(scratchId: string): boolean {
  return typeof scratchId === "string" && isValidScratchStateId(scratchId);
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
