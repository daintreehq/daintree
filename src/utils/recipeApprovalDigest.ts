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
 * DRIFT DETECTION, NOT A MAC. It answers "is this still the recipe the dialog
 * rendered?", and the answer only ever withdraws authority. The recipe editing
 * that would move it is either the user's own or an agent's — and an agent's
 * needs its own approval first, since `recipe.editor.open` and
 * `recipe.saveToRepo` are `danger: "safe"` but carry a `recipeId`, so
 * `resolveEffectiveActionDanger` raises them to `"confirm"` for agent sources.
 * Nothing here rests on a collision being hard to find, so a short non-crypto
 * hash is the right size: no async, no crypto import in the preview path, and
 * no recipe content retained on the approval record — a recipe is a plausible
 * home for a token, and a digest keeps values out of the object that travels.
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
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(",")}}`;
}

/** FNV-1a, 32-bit, as 8 hex characters. */
function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
