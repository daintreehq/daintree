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
  const canonicalKeys = canonical.map(stepIdentity);
  const localKeys = local.map(stepIdentity);
  const sequenceUnchanged =
    canonicalKeys.length === localKeys.length && canonicalKeys.every((k, i) => k === localKeys[i]);

  const canonicalGroups = groupIndices(canonicalKeys);
  const localGroups = groupIndices(localKeys);
  for (const [key, canonicalIdx] of canonicalGroups) {
    const localIdx = localGroups.get(key);
    if (!localIdx || localIdx.length !== canonicalIdx.length) continue;
    // Identical-looking steps pair in order only when nothing around them moved,
    // or when their values are the same so the pairing can't swap anything.
    // Otherwise `[A1, B, A2]` → `[B, A, A]` can't say which A moved.
    if (
      canonicalIdx.length > 1 &&
      !sequenceUnchanged &&
      !haveSameEnvValues(
        localIdx.map((i) => local[i]!),
        canonical[canonicalIdx[0]!]!
      )
    ) {
      continue;
    }
    canonicalIdx.forEach((ci, n) => {
      matched[ci] = local[localIdx[n]!];
    });
  }
  return matched;
}

function stepIdentity(step: RecipeTerminal): string {
  return JSON.stringify([
    step.type,
    step.title ?? null,
    step.command ?? null,
    step.devCommand ?? null,
    step.args ?? null,
    step.initialPrompt ?? null,
    step.panelKindId ?? null,
  ]);
}

function haveSameEnvValues(steps: readonly RecipeTerminal[], canonical: RecipeTerminal): boolean {
  const keys = Object.keys(canonical.env ?? {});
  const [first, ...rest] = steps;
  return rest.every((step) =>
    keys.every((key) => (step.env?.[key] ?? "") === (first!.env?.[key] ?? ""))
  );
}

function groupIndices(keys: readonly string[]): Map<string, number[]> {
  const groups = new Map<string, number[]>();
  keys.forEach((key, i) => {
    const group = groups.get(key);
    if (group) group.push(i);
    else groups.set(key, [i]);
  });
  return groups;
}
