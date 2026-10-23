import path from "node:path";

/**
 * Local files a person chose in a view — a drop, a paste, the file dialog —
 * as the preload resolved them from real `File`s (#14100). The renderer hands
 * plugin views a File, never a path; this is what lets a view import that
 * exact file as an artifact without letting page code name any path it
 * likes. A grant covers one file, once, for a minute.
 */
const GRANT_TTL_MS = 60_000;
const MAX_BATCH = 64;
const MAX_VIEWS = 64;
const MAX_PER_VIEW = 256;

const grants = new Map<number, Map<string, number>>();

export function recordArtifactSelectionGrants(
  webContentsId: number,
  paths: unknown,
  now: number = Date.now()
): void {
  if (!Array.isArray(paths) || paths.length > MAX_BATCH) return;
  let forView = grants.get(webContentsId);
  if (!forView) {
    while (grants.size >= MAX_VIEWS) {
      const oldest = grants.keys().next().value;
      if (oldest === undefined) break;
      grants.delete(oldest);
    }
    forView = new Map();
    grants.set(webContentsId, forView);
  }
  for (const candidate of paths) {
    if (typeof candidate !== "string" || !path.isAbsolute(candidate) || candidate.includes("\0")) {
      continue;
    }
    forView.delete(candidate);
    forView.set(candidate, now + GRANT_TTL_MS);
  }
  for (const [granted, until] of forView) {
    if (until <= now || forView.size > MAX_PER_VIEW) forView.delete(granted);
  }
}

/** Spend the view's grant for `filePath`; false when it has none (or it lapsed). */
export function consumeArtifactSelectionGrant(
  webContentsId: number,
  filePath: string,
  now: number = Date.now()
): boolean {
  const forView = grants.get(webContentsId);
  const until = forView?.get(filePath);
  if (until === undefined) return false;
  forView!.delete(filePath);
  return until > now;
}

export function clearArtifactSelectionGrantsForTests(): void {
  grants.clear();
}
