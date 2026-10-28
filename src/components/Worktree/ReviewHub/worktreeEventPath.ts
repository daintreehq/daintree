/**
 * The worktree path a worktree port event names: `worktree.path` on an update,
 * `tick.path` on a tick. Read without trusting the payload's shape.
 */
export function worktreeEventPath(data: unknown, key: "worktree" | "tick"): string | undefined {
  const inner: unknown =
    typeof data === "object" && data !== null ? Reflect.get(data, key) : undefined;
  const path: unknown =
    typeof inner === "object" && inner !== null ? Reflect.get(inner, "path") : undefined;
  return typeof path === "string" ? path : undefined;
}
