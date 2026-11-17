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
  const row: Project = { ...project };
  for (const [key, value] of Object.entries(updates)) {
    // The row is found by id on rollback; Main never lets a generic update change it.
    if (key === "id") continue;
    claims.set(key, {
      write,
      hadPrior: Object.hasOwn(project, key),
      prior: Reflect.get(project, key),
      previous: inherited?.get(key),
    });
    Reflect.set(row, key, value);
  }
  claimsByRow.set(row, claims);
  return row;
}

/**
 * Undoes only the fields `write` still owns on this row: a pending predecessor
 * takes the field back, a saved one leaves its value in place. Fields a newer
 * write owns stay, with `write` spliced out of their history so a later failure
 * of that newer write restores past it. Returns the same object when nothing
 * was restored.
 */
export function rollbackOptimisticProjectUpdate(
  project: Project,
  write: OptimisticProjectWrite
): Project {
  const claims = claimsByRow.get(project);
  if (!claims) return project;
  let next: Project | null = null;
  const remaining = new Map(claims);
  for (const [key, claim] of claims) {
    if (claim.write !== write) {
      spliceOut(claim, write);
      continue;
    }
    next ??= { ...project };
    if (claim.hadPrior) Reflect.set(next, key, claim.prior);
    else Reflect.deleteProperty(next, key);
    const owner = claim.previous?.write.status === "pending" ? claim.previous : undefined;
    if (owner) remaining.set(key, owner);
    else remaining.delete(key);
  }
  if (!next) return project;
  claimsByRow.set(next, remaining);
  return next;
}

/** A failed write's value never saved, so whatever overwrote it inherits its baseline. */
function spliceOut(claim: FieldClaim, write: OptimisticProjectWrite): void {
  for (let c = claim; c.previous; c = c.previous) {
    if (c.previous.write !== write) continue;
    c.hadPrior = c.previous.hadPrior;
    c.prior = c.previous.prior;
    c.previous = c.previous.previous;
    return;
  }
}

/** Copies `keys` from `row`, presence included; the same object when they already match. */
export function syncProjectFields(project: Project, row: Project, keys: string[]): Project {
  const next: Project = { ...project };
  for (const key of keys) {
    if (Object.hasOwn(row, key)) Reflect.set(next, key, Reflect.get(row, key));
    else Reflect.deleteProperty(next, key);
  }
  const same = keys.every(
    (k) =>
      Object.hasOwn(next, k) === Object.hasOwn(project, k) &&
      Object.is(Reflect.get(next, k), Reflect.get(project, k))
  );
  return same ? project : next;
}
