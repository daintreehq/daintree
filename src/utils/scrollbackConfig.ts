import type { TerminalType } from "@/types";

interface ScrollbackPolicy {
  multiplier: number;
  maxLines: number;
  minLines: number;
}

export const PERFORMANCE_MODE_SCROLLBACK = 100;

const SCROLLBACK_POLICIES: Record<TerminalType, ScrollbackPolicy> = {
  // Agent terminals: full base setting (need conversation history)
  claude: { multiplier: 1.0, maxLines: 10000, minLines: 1000 },
  gemini: { multiplier: 1.0, maxLines: 10000, minLines: 1000 },
  codex: { multiplier: 1.0, maxLines: 10000, minLines: 1000 },

  // Standard terminals: limited (ephemeral commands)
  terminal: { multiplier: 0.2, maxLines: 2000, minLines: 200 },
};

/**
 * Get appropriate scrollback lines for a terminal type based on the user's
 * base scrollback setting. Agent terminals get full base, standard terminals get 20%,
 * all clamped to type-specific min/max limits.
 */
export function getScrollbackForType(type: TerminalType, baseScrollback: number): number {
  const policy = SCROLLBACK_POLICIES[type] || SCROLLBACK_POLICIES.terminal;

  // Handle unlimited (0) or default (1000) by using maxLines for the type
  if (baseScrollback === 0 || baseScrollback === 1000) {
    // Default 1000 should also respect policy, not force it
    if (baseScrollback === 1000) {
      const calculated = Math.floor(baseScrollback * policy.multiplier);
      return Math.max(policy.minLines, Math.min(policy.maxLines, calculated));
    }
    return policy.maxLines;
  }

  // Calculate from base with multiplier, clamped to policy limits
  const calculated = Math.floor(baseScrollback * policy.multiplier);
  return Math.max(policy.minLines, Math.min(policy.maxLines, calculated));
}

const BYTES_PER_LINE = 250; // Average with ANSI codes

/**
 * Estimate memory usage for terminals based on type counts and base scrollback.
 */
export function estimateMemoryUsage(
  terminalCounts: Partial<Record<TerminalType, number>>,
  baseScrollback: number
): { perType: Record<TerminalType, number>; total: number } {
  const perType = {} as Record<TerminalType, number>;
  let total = 0;

  const allTypes: TerminalType[] = ["claude", "gemini", "codex", "terminal"];

  for (const type of allTypes) {
    const count = terminalCounts[type] ?? 0;
    const lines = getScrollbackForType(type, baseScrollback);
    const bytes = lines * BYTES_PER_LINE * count;
    perType[type] = bytes;
    total += bytes;
  }

  return { perType, total };
}

/**
 * Format bytes as human-readable string (e.g., "25 MB").
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Get scrollback limit summary for a terminal type given base setting.
 * Returns the actual limit that will be used.
 */
export function getScrollbackSummary(
  type: TerminalType,
  baseScrollback: number
): { limit: number; label: string } {
  const limit = getScrollbackForType(type, baseScrollback);

  const labels: Record<TerminalType, string> = {
    claude: "Claude",
    gemini: "Gemini",
    codex: "Codex",
    terminal: "Terminal",
  };

  return { limit, label: labels[type] || "Terminal" };
}
