/**
 * Files whose markup is a real ancestor of what the user sees but is never
 * theirs to edit: SvelteKit's generated route shell and anything shipped by a
 * dependency. Resolving into one is a failure, not a target.
 */
export function isGeneratedSourceFile(file: string): boolean {
  const path = file.replaceAll("\\", "/");
  return (
    path.startsWith(".svelte-kit/") ||
    path.includes("/.svelte-kit/") ||
    path.startsWith("node_modules/") ||
    path.includes("/node_modules/")
  );
}
