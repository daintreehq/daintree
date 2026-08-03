import type { ActionContext, ActionId } from "@shared/types/actions";

/**
 * Fail closed when an agent/MCP caller omits the terminal it means to act on.
 *
 * These actions resolve an omitted target from ambient focus. That is right for
 * a keybinding or a palette pick, where the person can see what is focused, and
 * wrong for a headless caller, which cannot. Focus also drifts across the
 * MCP→IPC round trip, so even a caller that knew the focused terminal when it
 * called can land somewhere else by the time `run()` executes (#11346, #11532).
 *
 * Deliberately `=== "agent"` rather than `!isForegroundDispatch(source)`: that
 * helper is an allowlist that fails *open* for an absent source, so reusing it
 * here would reject every dispatch that carries no context at all. `"plugin"`
 * keeps today's focus fallback — closing that is a separate capability call.
 *
 * MCP and the in-app assistant both dispatch with `source: "agent"`, and
 * `ActionService` stamps `dispatchSource` *after* spreading any
 * `contextOverride`, so a caller cannot spoof its way past this.
 *
 * Binding only: an explicitly named terminal that doesn't exist still reaches
 * each action's own existing handling, unchanged.
 */
export function requireExplicitTerminalIdForAgentDispatch(
  actionId: ActionId,
  terminalId: string | undefined,
  ctx: ActionContext
): void {
  if (ctx.dispatchSource === "agent" && !terminalId) {
    throw new Error(
      `${actionId} requires an explicit \`terminalId\` when dispatched by an agent or MCP client — pass the panel UUID from \`terminal.list\` (the \`id\` field).`
    );
  }
}
