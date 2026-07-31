/**
 * Pure launch-id validation shared by the launcher hook and the action layer.
 *
 * Lives outside `useAgentLauncher.ts` so an action definition can validate an
 * agent id without importing that hook — it pulls React, the IPC clients, and
 * a half-dozen Zustand stores into whatever module graph imports it, which is
 * the wrong dependency direction for action registration (#11547).
 */

/**
 * Sanitize an assistant-supplied string for use as a panel title or an echoed
 * error fragment. Strips ASCII control characters (an LLM could emit newlines,
 * tabs, or ANSI escape sequences), collapses internal whitespace, and trims.
 * Returns "" when nothing printable remains, which the title path treats as
 * "no name" (falls back to the default computed title with no `titleMode` pin).
 */
export function sanitizeTerminalName(raw: string): string {
  let out = "";
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    // Drop C0 controls (0x00–0x1f) and DEL (0x7f); replace with a space so
    // adjacent words don't fuse, then collapse the runs below.
    out += code <= 0x1f || code === 0x7f ? " " : ch;
  }
  return out.replace(/\s+/g, " ").trim();
}

/**
 * Classify a launch id, rejecting one that resolves to no agent. Without this,
 * an unregistered id left `isAgent` false and fell through to the generic
 * terminal branch, spawning a plain shell and reporting success — a typo'd id
 * from MCP looked identical to a launched agent (#11498). Throwing (rather than
 * returning null) is what makes it visible: `ActionService` serializes a
 * rejection as `ok:false`/`EXECUTION_ERROR`, while a resolved null reads as a
 * terminal-less success.
 *
 * Returns the kind rather than just asserting so the call site stays
 * load-bearing: deleting it breaks `isAgent` instead of quietly restoring the
 * fallback this fixes.
 *
 * `"terminal"` is the deliberate plain-shell launch, accepted unregistered
 * because no built-in agent claims that id. A plugin or user agent may still
 * register it, in which case it resolves as an agent — unchanged from before.
 * `"browser"` and `"dev-preview"` return from their own panel branches earlier
 * and never reach here, so they are not accepted: this stays correct standalone
 * and fails closed if either branch is ever bypassed.
 */
export function resolveAgentLaunchKind(
  agentId: string,
  isRegistered: boolean
): "agent" | "terminal" {
  if (isRegistered) return "agent";
  if (agentId === "terminal") return "terminal";
  // The id can arrive from an LLM via MCP, so keep it printable and bounded —
  // otherwise it can forge log lines or bloat the error crossing the boundary.
  const safeId = sanitizeTerminalName(agentId).slice(0, 80);
  throw new Error(
    `Unknown agent ID '${safeId}'. Call agent.listAvailable for registered agent IDs, ` +
      `then retry, or use terminal.new to open a plain terminal.`
  );
}
