import type { Project } from "@shared/types";

export interface OptimisticProjectWrite {
  status: "pending" | "saved" | "failed";
}

interface FieldClaim {
  write: OptimisticProjectWrite;
  hadPrior: boolean;
  prior: unknown;
  /** The claim this write overwrote, so a failure can hand the field back to it. */
  previous: FieldClaim | undefined;
}

/**
 * Which write put each optimistic field on a project row (#17520). Keyed by the
 * row objects `updateProject` builds: every other writer (a reload, Main's
 * `onUpdated` push, hydration) hands the store a fresh object with no entry, so
 * Main's values supersede a pending write's claim even when they compare equal,
 * and a dropped row takes its claims with it.
 */
const claimsByRow = new WeakMap<Project, ReadonlyMap<string, FieldClaim>>();

export function applyOptimisticProjectUpdate(
  project: Project,
  updates: Partial<Project>,
  write: OptimisticProjectWrite
): Project {
  const inherited = claimsByRow.get(project);
  const claims = new Map(inherited);
  const next: Record<string, unknown> = { ...project };
  for (const [key, value] of Object.entries(updates)) {
    // The row is found by id on rollback; Main never lets a generic update change it.
    if (key === "id") continue;
    claims.set(key, {
      write,
      hadPrior: Object.hasOwn(project, key),
      prior: (project as unknown as Record<string, unknown>)[key],
      previous: inherited?.get(key),
    });
    next[key] = value;
  }
  const row = next as unknown as Project;
  claimsByRow.set(row, claims);
  return row;
}

/**
 * Undoes only the fields `write` still owns on this row. A failed predecessor is
 * skipped (its value never saved), a pending one takes the field back, and a
 * saved one leaves its value in place. Returns the same object when nothing was
 * restored.
 */
export function rollbackOptimisticProjectUpdate(
  project: Project,
  write: OptimisticProjectWrite
): Project {
  const claims = claimsByRow.get(project);
  if (!claims) return project;
  let next: Record<string, unknown> | null = null;
  const remaining = new Map(claims);
  for (const [key, claim] of claims) {
    if (claim.write !== write) continue;
    let base = claim;
    while (base.previous?.write.status === "failed") base = base.previous;
    next ??= { ...project };
    if (base.hadPrior) next[key] = base.prior;
    else delete next[key];
    if (base.previous?.write.status === "pending") remaining.set(key, base.previous);
    else remaining.delete(key);
  }
  if (!next) return project;
  const row = next as unknown as Project;
  claimsByRow.set(row, remaining);
  return row;
}
