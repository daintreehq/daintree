import type { RecipeTerminal } from "../types/index.js";

/**
 * Pairs each canonical (in-repo) recipe step with the local mirror step that is
 * the same logical step, so local-only env values never follow an array index
 * onto another command (#14360). Steps carry no stable id, so identity is what
 * the step launches; a step that can't be matched unambiguously gets no
 * partner and its values must be configured again.
 */
export function matchRecipeSteps(
  canonical: readonly RecipeTerminal[],
  local: readonly RecipeTerminal[]
): (RecipeTerminal | undefined)[] {
  const matched: (RecipeTerminal | undefined)[] = canonical.map(() => undefined);
  const claimedLocal = new Set<number>();

  const canonicalGroups = groupIndices(canonical, stepIdentity);
  const localGroups = groupIndices(local, stepIdentity);
  // Indistinguishable steps that appear the same number of times pair in order:
  // the redacted canonical file can't show they moved among themselves. A
  // changed count means one was added or removed, and nothing says which.
  const ambiguousLocal = new Set<number>();
  for (const [key, canonicalIdx] of canonicalGroups) {
    const localIdx = localGroups.get(key);
    if (!localIdx) continue;
    if (localIdx.length !== canonicalIdx.length) {
      for (const i of localIdx) ambiguousLocal.add(i);
      continue;
    }
    canonicalIdx.forEach((ci, n) => {
      matched[ci] = local[localIdx[n]!];
      claimedLocal.add(localIdx[n]!);
    });
  }

  // An edited step keeps its values when its type plus title or command still
  // names exactly one unmatched local step, and nothing else claims that step.
  const candidates = new Map<number, number[]>();
  const claimants = new Map<number, number>();
  canonical.forEach((step, ci) => {
    if (matched[ci] || canonicalGroups.get(stepIdentity(step))!.length > 1) return;
    const found: number[] = [];
    local.forEach((other, li) => {
      if (claimedLocal.has(li) || ambiguousLocal.has(li)) return;
      if (isSameEditedStep(step, other)) found.push(li);
    });
    candidates.set(ci, found);
    for (const li of found) claimants.set(li, (claimants.get(li) ?? 0) + 1);
  });
  for (const [ci, found] of candidates) {
    if (found.length === 1 && claimants.get(found[0]!) === 1) {
      matched[ci] = local[found[0]!];
    }
  }

  return matched;
}

function stepIdentity(step: RecipeTerminal): string {
  return JSON.stringify([
    step.type,
    step.title ?? null,
    step.command ?? null,
    step.devCommand ?? null,
    step.panelKindId ?? null,
  ]);
}

function isSameEditedStep(a: RecipeTerminal, b: RecipeTerminal): boolean {
  if (a.type !== b.type) return false;
  if (a.title && a.title === b.title) return true;
  return Boolean(a.command && a.command === b.command);
}

function groupIndices<T>(items: readonly T[], keyOf: (item: T) => string): Map<string, number[]> {
  const groups = new Map<string, number[]>();
  items.forEach((item, i) => {
    const key = keyOf(item);
    const group = groups.get(key);
    if (group) group.push(i);
    else groups.set(key, [i]);
  });
  return groups;
}
