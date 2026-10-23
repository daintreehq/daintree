import { PTY_MIRROR_SCROLLBACK } from "@shared/config/scrollback";

export const PERFORMANCE_MODE_SCROLLBACK = 100;

interface ScrollbackPolicy {
  multiplier: number;
  maxLines: number;
  minLines: number;
}

// The agent ceiling is the pty-host mirror's depth: every restore replays from
// that mirror, so lines kept beyond it would only exist while the view stays warm.
const AGENT_POLICY: ScrollbackPolicy = {
  multiplier: 10,
  maxLines: PTY_MIRROR_SCROLLBACK,
  minLines: 500,
};
const PLAIN_POLICY: ScrollbackPolicy = { multiplier: 0.3, maxLines: 2000, minLines: 200 };

export const AGENT_SCROLLBACK_MAX_LINES = AGENT_POLICY.maxLines;
export const PLAIN_SCROLLBACK_MIN_LINES = PLAIN_POLICY.minLines;
export const PLAIN_SCROLLBACK_MAX_LINES = PLAIN_POLICY.maxLines;

// Resource-profile ceiling on the agent policy. Pushed by useResourceProfile
// (same pattern as TerminalWebGLConfig); the initial value matches the
// balanced profile's effective ceiling. Held here, isolated from the profile
// types, so the eager renderer chunk can update it without new import edges.
let agentScrollbackMaxLines = AGENT_POLICY.maxLines;

export function setAgentScrollbackMaxLines(lines: number): void {
  if (!Number.isFinite(lines)) return;
  // Stored clamped to the policy so a profile budget above the mirror cap reads
  // back as the cap — useResourceProfile compares before/after to decide whether
  // to re-derive every open terminal, and a raw 10k vs 5k would walk them all
  // for no change.
  agentScrollbackMaxLines = Math.min(
    AGENT_POLICY.maxLines,
    Math.max(AGENT_POLICY.minLines, Math.floor(lines))
  );
}

export function getAgentScrollbackMaxLines(): number {
  return agentScrollbackMaxLines;
}

/**
 * Get appropriate scrollback lines based on whether an agent is live in the
 * terminal. Agent terminals (or terminals launched to run an agent) get the
 * larger scrollback policy; plain shells get the smaller one. The agent
 * ceiling is the lower of the pty-host mirror depth and the resource profile's
 * ceiling (efficiency lowers it to 4k).
 */
export function getScrollbackForType(isAgent: boolean, baseScrollback: number): number {
  const policy = isAgent ? AGENT_POLICY : PLAIN_POLICY;
  const maxLines = isAgent ? Math.min(policy.maxLines, agentScrollbackMaxLines) : policy.maxLines;

  // Handle unlimited (0) by using the policy's maxLines
  if (baseScrollback === 0) {
    return maxLines;
  }

  const calculated = Math.floor(baseScrollback * policy.multiplier);
  return Math.max(policy.minLines, Math.min(maxLines, calculated));
}

// xterm.js 6 allocates every BufferLine at the full pane width: CELL_SIZE(3) ×
// 4 bytes per cell, plus ~240 bytes of V8/object/_combined overhead. Agent panes
// run far wider than 80 columns, so the estimate assumes a typical wide pane
// and the settings copy says so.
export const SCROLLBACK_ESTIMATE_COLUMNS = 180;
const BYTES_PER_CELL = 12;
const BYTES_PER_LINE_OVERHEAD = 240;
const BYTES_PER_LINE = SCROLLBACK_ESTIMATE_COLUMNS * BYTES_PER_CELL + BYTES_PER_LINE_OVERHEAD;

/** Estimated bytes for a filled buffer of `lines` at the assumed pane width. */
export function bytesForScrollbackLines(lines: number): number {
  return lines * BYTES_PER_LINE;
}

/**
 * Estimate filled-scrollback memory for a mix of agent/plain terminals, each
 * holding the given number of lines. Takes resolved limits rather than a base
 * setting so callers price what terminals actually keep (performance mode's
 * flat cap is not a base to scale).
 */
export function estimateMemoryUsage(
  terminalCounts: { agent: number; plain: number },
  linesPerTerminal: { agent: number; plain: number }
): { agent: number; plain: number; total: number } {
  const agentBytes = bytesForScrollbackLines(linesPerTerminal.agent) * terminalCounts.agent;
  const plainBytes = bytesForScrollbackLines(linesPerTerminal.plain) * terminalCounts.plain;
  return { agent: agentBytes, plain: plainBytes, total: agentBytes + plainBytes };
}

/**
 * Get scrollback limit summary given base setting. Returns the limit that
 * will be used for an agent or plain terminal along with a display label.
 */
export function getScrollbackSummary(
  isAgent: boolean,
  baseScrollback: number
): { limit: number; label: string } {
  return {
    limit: getScrollbackForType(isAgent, baseScrollback),
    label: isAgent ? "Agent" : "Terminal",
  };
}
