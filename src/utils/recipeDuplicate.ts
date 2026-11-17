// Strip an existing trailing "(Copy)" or "(Copy N)" suffix so duplicating
// "Foo (Copy)" produces "Foo (Copy 2)", not "Foo (Copy) (Copy)".
const COPY_SUFFIX = /\s*\(Copy(?:\s+\d+)?\)$/;

// safeRecipeFilename caps the on-disk filename at 200 chars; without reserving
// room for " (Copy NNN)", a 200-char name's copies all truncate to the same
// filename and silently overwrite the original on disk.
const MAX_DUPLICATE_ROOT_LEN = 180;

// Recipe ids are opaque now, so duplicate detection keys on the human-visible
// name instead of a name-derived id. Picking an unused name keeps the copy
// distinct in the UI and (via safeRecipeFilename) on disk.
export function nextDuplicateName(baseName: string, existingNames: Set<string>): string {
  let root = baseName.replace(COPY_SUFFIX, "");
  if (root.length > MAX_DUPLICATE_ROOT_LEN) {
    root = root.slice(0, MAX_DUPLICATE_ROOT_LEN);
  }
  for (let i = 1; i <= 100; i++) {
    const candidate = i === 1 ? `${root} (Copy)` : `${root} (Copy ${i})`;
    if (!existingNames.has(candidate)) {
      return candidate;
    }
  }
  // Fallback: bound the loop so a pathological state can't hang the renderer.
  return `${root} (Copy ${Date.now()})`;
}
