import type { ActionSource } from "@shared/types";
import type { CopyTreeRunSource } from "@shared/types";

/**
 * Map an action dispatch onto the surface recorded in the copy-tree history
 * (#11732).
 *
 * `ActionSource` cannot answer this alone: the worktree card and the file
 * browser both dispatch as `"context-menu"`, and every agent path — external
 * MCP client or the in-app assistant, which drives the IDE through the same
 * manifest — dispatches as `"agent"`. So a caller that knows which surface it
 * is passes `explicit` and wins; only the unambiguous cases are inferred.
 *
 * Anything else resolves to `"unknown"` rather than being attributed to the
 * most likely surface — a wrong label in the history is worse than no label,
 * because the history is what a user re-runs from.
 */
export function resolveCopyTreeRunSource(
  dispatchSource: ActionSource | undefined,
  explicit?: CopyTreeRunSource
): CopyTreeRunSource {
  if (explicit) return explicit;
  if (dispatchSource === "keybinding") return "shortcut";
  if (dispatchSource === "agent") return "mcp";
  return "unknown";
}
