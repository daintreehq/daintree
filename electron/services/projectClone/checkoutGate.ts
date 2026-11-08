import path from "path";

/**
 * Projects that have no checkout yet because their clone is running or ended
 * without one (#16352), by id and by path. The project row is the record; this
 * is the in-memory copy the hot paths read (every PTY spawn, every workspace
 * load), so they never reach for the database or the project store.
 */
const pendingById = new Map<string, string>();
const pendingByPath = new Map<string, string>();

function normalize(projectPath: string): string {
  return path.resolve(projectPath).normalize("NFC");
}

export function markCheckoutPending(projectId: string, projectPath: string): void {
  clearCheckoutPending(projectId);
  const normalized = normalize(projectPath);
  pendingById.set(projectId, normalized);
  pendingByPath.set(normalized, projectId);
}

export function clearCheckoutPending(projectId: string): void {
  const normalized = pendingById.get(projectId);
  if (normalized === undefined) return;
  pendingById.delete(projectId);
  if (pendingByPath.get(normalized) === projectId) pendingByPath.delete(normalized);
}

export function isCheckoutPendingProject(projectId: string | null | undefined): boolean {
  return typeof projectId === "string" && pendingById.has(projectId);
}

export function isCheckoutPendingPath(projectPath: string | null | undefined): boolean {
  return typeof projectPath === "string" && pendingByPath.has(normalize(projectPath));
}

/** Test seam: forget every pending checkout. */
export function resetCheckoutGateForTests(): void {
  pendingById.clear();
  pendingByPath.clear();
}
