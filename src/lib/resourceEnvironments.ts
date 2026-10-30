/**
 * "local" is the worktree mode every picker and the workspace host read as
 * Local, so an environment saved under that key is never looked up and can't
 * run anything. Matched exactly: "Local" is a different key and works.
 */
export function isReservedEnvironmentKey(key: string): boolean {
  return key === "local";
}

/** The environment keys a worktree can actually be put in. */
export function usableEnvironmentKeys(environments: Record<string, unknown> | undefined): string[] {
  return Object.keys(environments ?? {}).filter((key) => !isReservedEnvironmentKey(key));
}
