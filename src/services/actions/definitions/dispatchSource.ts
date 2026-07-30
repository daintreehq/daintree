import type { ActionSource } from "@shared/types/actions";

/**
 * Sources that mean a person just asked for this, right now.
 *
 * `addPanel` resolves `focusPolicy` from ambient guards — a live MCP
 * spawn-suppression lease or the assistant owning keyboard focus both force
 * `"preserve"`, which skips focus AND leaves a fullscreen cell rendering over
 * the new panel (#11506). Those guards exist to stop a background spawn
 * stealing focus from someone typing (#6959); they were never meant to
 * suppress an open the user issued themselves, and the lease is coarse enough
 * (a time window covering a whole MCP dispatch) to catch unrelated human
 * actions that overlap it.
 *
 * So an open-panel action classifies its own dispatch: foreground sources pass
 * an explicit `focusPolicy: "take"`, which bypasses both guards and reaches
 * `exitMaximize()`. Everything else keeps today's store-resolved behavior.
 *
 * Deliberately an allowlist rather than `!== "agent"`: `"plugin"`, a missing
 * context, and any source added later all fall through to the ambient guards,
 * which is the safe default.
 */
const FOREGROUND_DISPATCH_SOURCES = new Set<ActionSource>([
  "user",
  "keybinding",
  "menu",
  "context-menu",
]);

/** Did a person issue this dispatch directly, rather than an agent or plugin? */
export function isForegroundDispatch(source: ActionSource | undefined): boolean {
  return source !== undefined && FOREGROUND_DISPATCH_SOURCES.has(source);
}
