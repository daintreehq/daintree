/**
 * Convert an arbitrary recipe name into a safe filesystem filename.
 * Strips diacritics, forbidden chars, collapses whitespace to hyphens,
 * and truncates to 200 chars before appending ".json".
 */
export function safeRecipeFilename(name: string): string {
  const base =
    name
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "") // strip combining diacritics
      .replace(/[\\/:*?"<>|]/g, "") // strip OS-forbidden chars
      .replace(/\s+/g, "-") // spaces → hyphens
      .replace(/-+/g, "-") // collapse consecutive hyphens
      .toLowerCase()
      .slice(0, 200)
      // Trailing-strip runs after slice so a hyphen or dot left dangling at
      // position 200 (e.g. interior whitespace at char 199) is removed.
      .replace(/^[-.]+|[-.]+$/g, "") || "recipe";

  return `${base}.json`;
}

/**
 * Compute the legacy name-derived in-repo recipe ID.
 *
 * New in-repo recipes use an opaque `crypto.randomUUID()` id instead, so this
 * is retained only for (a) the deterministic backfill of legacy files that
 * predate the opaque-id scheme and lack an explicit `id`, and (b) detecting
 * those legacy ids. It must NOT be used to (re)derive an id on a recipe rename
 * — doing so was the bug that #9195 fixed.
 */
export function stableInRepoId(name: string): string {
  return `inrepo-${safeRecipeFilename(name).replace(/\.json$/, "")}`;
}

/**
 * Check whether a recipe denotes an in-repo recipe.
 *
 * Accepts either a bare id string (legacy callers — only the `inrepo-` prefix
 * is checked) or the recipe object, which is preferred because opaque-UUID
 * in-repo recipes are identified by their `scope: "inrepo"` field, not the id.
 */
export function isInRepoRecipeId(idOrRecipe: string | { id: string; scope?: string }): boolean {
  if (typeof idOrRecipe === "string") {
    return idOrRecipe.startsWith("inrepo-");
  }
  return idOrRecipe.scope === "inrepo" || idOrRecipe.id.startsWith("inrepo-");
}
