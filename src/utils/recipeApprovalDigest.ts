import type { RecipeTerminal } from "@shared/types/project";

/**
 * A stable fingerprint of the terminals a confirm dialog listed (#12263).
 *
 * An approval names a recipe id and a count, and neither says WHAT was in the
 * dialog. A recipe can be rewritten under the same id while the modal waits —
 * `useRecipeFocusReload` re-reads in-repo recipes whenever the window regains
 * focus, which is exactly what happens when someone alt-tabs back to click
 * Approve — and the composites (`worktree.createWithRecipe`,
 * `workflow.startWorkOnIssue`) then await a worktree creation before the recipe
 * runs at all. Without a content check, the same-count-same-id case would run
 * commands nobody was shown.
 *
 * Drift detection: it answers "is this still the recipe the dialog rendered?",
 * and the answer only ever withdraws authority. Non-crypto on purpose — no
 * async and no crypto import in a path the modal's approve button waits on —
 * but 64 bits rather than 32, because a 32-bit digest is collidable by hand.
 * The editing that moves a recipe needs a human either way (an agent's
 * `recipe.editor.open` and `recipe.saveToRepo` are `danger: "safe"` but carry a
 * `recipeId`, so `resolveEffectiveActionDanger` raises them to `"confirm"`),
 * yet a width someone could grind against while a dialog waits is a bad shape
 * for an authority token whatever the surrounding gates are.
 *
 * A digest rather than the terminals themselves keeps recipe content off the
 * record that travels: a recipe is a plausible home for a token, and the
 * preview hides env VALUES precisely because a dialog is not where they belong.
 *
 * Digests the WHOLE terminal, not a hand-listed subset of launch-relevant
 * fields. A subset would silently stop covering any field added later, which is
 * the failure this exists to prevent. Frecency metadata (`lastUsedAt`,
 * `usageHistory`) lives on the recipe rather than its terminals and is
 * excluded by construction — the store stamps it on every run, so including it
 * would invalidate every approval it issued.
 */
export function recipeApprovalDigest(terminals: readonly RecipeTerminal[]): string {
  return fnv1a(stableStringify(terminals));
}

/** JSON with object keys emitted in sorted order, so key order can't move a digest. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record: Record<string, unknown> = { ...value };
  const entries = Object.entries(record)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(",")}}`;
}

/**
 * FNV-1a as 16 hex characters.
 *
 * Two 32-bit lanes with different offset bases rather than true 64-bit FNV:
 * JavaScript numbers cannot hold the 64-bit prime multiply without BigInt, and
 * two independent lanes over the same input reach the width that matters here
 * at the cost of one extra multiply per character.
 */
function fnv1a(input: string): string {
  let low = 0x811c9dc5;
  let high = 0x01000193;
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    low = Math.imul(low ^ code, 0x01000193);
    high = Math.imul(high ^ code, 0x85ebca6b);
  }
  return (low >>> 0).toString(16).padStart(8, "0") + (high >>> 0).toString(16).padStart(8, "0");
}
