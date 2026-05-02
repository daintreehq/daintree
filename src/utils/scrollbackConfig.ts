export const PERFORMANCE_MODE_SCROLLBACK = 100;

interface ScrollbackPolicy {
  multiplier: number;
  maxLines: number;
  minLines: number;
}

const AGENT_POLICY: ScrollbackPolicy = { multiplier: 1.5, maxLines: 5000, minLines: 500 };
const PLAIN_POLICY: ScrollbackPolicy = { multiplier: 0.3, maxLines: 2000, minLines: 200 };

/**
 * Get appropriate scrollback lines based on whether an agent is live in the
 * terminal. Agent terminals (or terminals launched to run an agent) get the
 * larger scrollback policy; plain shells get the smaller one.
 */
export function getScrollbackForType(isAgent: boolean, baseScrollback: number): number {
  const policy = isAgent ? AGENT_POLICY : PLAIN_POLICY;

  // Handle unlimited (0) by using the policy's maxLines
  if (baseScrollback === 0) {
    return policy.maxLines;
  }

  const calculated = Math.floor(baseScrollback * policy.multiplier);
  return Math.max(policy.minLines, Math.min(policy.maxLines, calculated));
}

// xterm.js 6 BufferLine: 80 cols × CELL_SIZE(3) × 4 bytes/cell = 960 raw
// + ~240 V8/object/_combined overhead = ~1,200 bytes/line
const BYTES_PER_LINE = 1200;

/**
 * Estimate memory usage for a mix of agent/plain terminals at the given
 * base scrollback setting.
 */
export function estimateMemoryUsage(
  terminalCounts: { agent: number; plain: number },
  baseScrollback: number
): { agent: number; plain: number; total: number } {
  const agentBytes =
    getScrollbackForType(true, baseScrollback) * BYTES_PER_LINE * terminalCounts.agent;
  const plainBytes =
    getScrollbackForType(false, baseScrollback) * BYTES_PER_LINE * terminalCounts.plain;
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
