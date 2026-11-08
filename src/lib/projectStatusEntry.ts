import type { ProjectStatusEntry, ProjectStatusMap } from "@shared/types/ipc/project";

/**
 * Field by field over whatever keys either side carries, so a field added to
 * the entry later is compared without anyone remembering to list it. Every
 * field is a primitive, and an omitted optional reads the same as an
 * undefined one.
 */
export function isSameProjectStatusEntry(a: ProjectStatusEntry, b: ProjectStatusEntry): boolean {
  if (a === b) return true;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)] as Array<keyof ProjectStatusEntry>);
  for (const key of keys) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

export function isSameProjectStatusMap(a: ProjectStatusMap, b: ProjectStatusMap): boolean {
  if (a === b) return true;
  const ids = Object.keys(a);
  if (ids.length !== Object.keys(b).length) return false;
  for (const id of ids) {
    const entry = b[id];
    if (entry === undefined || !isSameProjectStatusEntry(a[id]!, entry)) return false;
  }
  return true;
}
