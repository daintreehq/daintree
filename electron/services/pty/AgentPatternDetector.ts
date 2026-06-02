/**
 * Agent-specific pattern detection for working state.
 *
 * Each agent CLI displays distinct status lines when actively processing:
 * - Claude: "✽ Deliberating… (esc to interrupt · 15s)"
 * - Gemini: "⠼ Unpacking Project Details (esc to cancel, 14s)"
 * - Codex: "• Working (1s • esc to interrupt)"
 *
 * This detector scans terminal output for these patterns to provide
 * high-confidence working state detection, complementing the timing-based
 * ActivityMonitor.
 */

export interface PatternDetectionConfig {
  /**
   * Primary patterns that indicate working state (high confidence).
   * Any match = agent is working.
   */
  primaryPatterns: RegExp[];

  /**
   * Fallback patterns to check when primary doesn't match (medium confidence).
   * Used for early-stage output before full status line appears.
   */
  fallbackPatterns?: RegExp[];

  /**
   * Number of lines from end of output to scan (default: 10).
   */
  scanLineCount?: number;

  /**
   * Confidence level when primary pattern matches (default: 0.95).
   */
  primaryConfidence?: number;

  /**
   * Confidence level when fallback pattern matches (default: 0.75).
   */
  fallbackConfidence?: number;
}

export interface PatternDetectionResult {
  /**
   * Whether a working pattern was detected.
   */
  isWorking: boolean;

  /**
   * Confidence level of the detection (0-1).
   */
  confidence: number;

  /**
   * Which pattern tier matched: "primary", "fallback", or "none".
   */
  matchTier: "primary" | "fallback" | "none";

  /**
   * The matched pattern text (for debugging).
   */
  matchedText?: string;
}

/**
 * Strip ANSI escape codes from text for pattern matching.
 * Handles CSI sequences, OSC sequences, and simple escape sequences.
 */
export function stripAnsi(text: string): string {
  // CSI sequences: ESC [ ... <final byte>
  // OSC sequences: ESC ] ... (ST | BEL)
  // Simple escapes: ESC <char>
  // Note: Control characters are intentional for ANSI escape matching
  /* eslint-disable no-control-regex */
  return text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "") // CSI sequences
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "") // OSC sequences
    .replace(/\x1b[()][AB012]/g, "") // Character set designation
    .replace(/\x1b[=>]/g, "") // Keypad mode
    .replace(/\x1b[78]/g, "") // Save/restore cursor
    .replace(/\x1b[DME]/g, "") // Line control
    .replace(/\x1b[@-Z\\-_]/g, ""); // 7-bit C1 escapes
  /* eslint-enable no-control-regex */
}

/**
 * Agent-specific pattern configurations.
 * These patterns are derived from observing actual CLI output.
 */
export const AGENT_PATTERN_CONFIGS: Record<string, PatternDetectionConfig> = {
  claude: {
    primaryPatterns: [
      // Full format with interrupt hint (superset: v2.1.79 chars + legacy)
      /[·*✢✳✶✻✽●✼✾⟡◇◆○]\s+[^()\n]{2,80}\s*\(esc to interrupt/i,
      // Simple: just "esc to interrupt" at end of line (handles long/wrapped text)
      /esc to interrupt[^)\n]*\)?$/im,
      // Time + escape hint structure: (15s · esc to interrupt)
      /\(\d+s\s*[·•]\s*esc to interrupt/i,
    ],
    fallbackPatterns: [
      // Structural: distinctive spinner + any verb + Unicode ellipsis (verb-agnostic)
      /[✢✳✶✻✽●]\s+\w+…/i,
    ],
    scanLineCount: 10,
    primaryConfidence: 0.95,
    fallbackConfidence: 0.75,
  },

  gemini: {
    primaryPatterns: [
      // ASCII spinner + text + cancel hint (short descriptions)
      /[⠀-⣿]\s+[^()\n]{2,80}\s*\(esc to cancel/i,
      // Simple: just "esc to cancel" at end of line (handles long/wrapped text)
      /esc to cancel[^)\n]*\)?$/im,
      // Time + escape hint structure: (14s, esc to cancel)
      /\(\d+s,?\s*esc to cancel/i,
    ],
    fallbackPatterns: [
      // Just the spinner (Braille dots used by Gemini — full U+2800–U+28FF block)
      /[⠀-⣿]\s+\w/,
    ],
    scanLineCount: 10,
    primaryConfidence: 0.95,
    fallbackConfidence: 0.7,
  },

  codex: {
    primaryPatterns: [
      // Full format with interrupt hint (short descriptions)
      /[•·]\s+[^()\n]{2,80}\s+\([^)]*esc to interrupt/i,
      // Simple: just "esc to interrupt" at end of line (handles long/wrapped text)
      /esc to interrupt[^)\n]*\)?$/im,
      // Time + escape hint structure: (4s • esc to interrupt)
      /\(\d+s\s*[·•]\s*esc to interrupt/i,
    ],
    fallbackPatterns: [
      // Minimal "Working" indicator
      /[•·]\s+Working/i,
    ],
    scanLineCount: 10,
    primaryConfidence: 0.95,
    fallbackConfidence: 0.75,
  },
};

/**
 * Universal patterns that work across all agents.
 * Used when agent-specific patterns aren't configured.
 */
export const UNIVERSAL_PATTERN_CONFIG: PatternDetectionConfig = {
  primaryPatterns: [
    // Full format patterns (superset: v2.1.79 Claude chars + legacy + Gemini + Codex)
    /[·*✢✳✶✻✽●✼✾⟡◇◆○•⠀-⣿]\s+[^()\n]{2,80}\s*\(esc to interrupt/i,
    /[·*✢✳✶✻✽●✼✾⟡◇◆○•⠀-⣿]\s+[^()\n]{2,80}\s*\(esc to cancel/i,
    /[·*✢✳✶✻✽●✼✾⟡◇◆○•⠀-⣿]\s+[^()\n]{2,80}\s*\(escape to interrupt/i,
    // Simple: escape hints at end of line (handles long/wrapped text)
    /esc to interrupt[^)\n]*\)?$/im,
    /esc to cancel[^)\n]*\)?$/im,
    /escape to interrupt[^)\n]*\)?$/im,
    // Time + escape hint structures
    /\(\d+s\s*[·•]\s*esc to interrupt/i,
    /\(\d+s,?\s*esc to cancel/i,
  ],
  fallbackPatterns: [
    // Common spinner characters followed by activity
    /[✢✳✶✻✽●•⠀-⣿]\s+(thinking|working|loading|processing|running)/i,
  ],
  scanLineCount: 10,
  primaryConfidence: 0.9,
  fallbackConfidence: 0.65,
};

/**
 * Detects agent working state by scanning terminal output for known patterns.
 */
export class AgentPatternDetector {
  private readonly config: PatternDetectionConfig;
  private readonly scanLineCount: number;

  constructor(agentId?: string, customConfig?: PatternDetectionConfig) {
    if (customConfig) {
      this.config = customConfig;
    } else if (agentId && AGENT_PATTERN_CONFIGS[agentId]) {
      this.config = AGENT_PATTERN_CONFIGS[agentId];
    } else {
      this.config = UNIVERSAL_PATTERN_CONFIG;
    }

    this.scanLineCount = this.config.scanLineCount ?? 10;
  }

  /**
   * Run the configured pattern tiers against pre-windowed, ANSI-stripped text.
   * Uses `RegExp.test` rather than `String.match` to avoid allocating a match
   * array on the per-chunk hot path — the matched substring is never consumed.
   */
  private matchPatterns(textToScan: string): PatternDetectionResult {
    // Try primary patterns first (high confidence)
    for (const pattern of this.config.primaryPatterns) {
      // Reset lastIndex so a stateful (/g, /y) pattern can't carry position
      // across calls — restores the per-call semantics the old .match() had.
      pattern.lastIndex = 0;
      if (pattern.test(textToScan)) {
        return {
          isWorking: true,
          confidence: this.config.primaryConfidence ?? 0.95,
          matchTier: "primary",
        };
      }
    }

    // Try fallback patterns (medium confidence)
    if (this.config.fallbackPatterns) {
      for (const pattern of this.config.fallbackPatterns) {
        pattern.lastIndex = 0;
        if (pattern.test(textToScan)) {
          return {
            isWorking: true,
            confidence: this.config.fallbackConfidence ?? 0.75,
            matchTier: "fallback",
          };
        }
      }
    }

    // No patterns matched
    return {
      isWorking: false,
      confidence: 0,
      matchTier: "none",
    };
  }

  /**
   * Find the offset of the last `scanLineCount` lines within `text` without
   * allocating a per-line array. Equivalent to
   * `text.split("\n").slice(-scanLineCount).join("\n")` but returns a single
   * slice offset, avoiding the intermediate array and segment strings.
   */
  private lastLinesOffset(text: string): number {
    let startOffset = 0;
    let searchFrom = text.length;
    for (let i = 0; i < this.scanLineCount; i++) {
      const nl = text.lastIndexOf("\n", searchFrom - 1);
      if (nl === -1) {
        // Fewer than scanLineCount lines — scan the whole string.
        return 0;
      }
      startOffset = nl + 1;
      searchFrom = nl;
    }
    return startOffset;
  }

  /**
   * Detect working state from terminal output.
   *
   * @param output Terminal output. Raw (may include ANSI codes) unless
   *   `opts.alreadyStripped` is set.
   * @param opts.alreadyStripped When true, `output` is assumed to already be
   *   ANSI-stripped and the internal strip is skipped (hot-path callers that
   *   strip once and reuse the result).
   * @returns Detection result with working state and confidence
   */
  detect(output: string, opts?: { alreadyStripped?: boolean }): PatternDetectionResult {
    if (!output || output.length === 0) {
      return {
        isWorking: false,
        confidence: 0,
        matchTier: "none",
      };
    }

    // Strip ANSI codes for reliable pattern matching (unless already stripped).
    const cleanOutput = opts?.alreadyStripped ? output : stripAnsi(output);

    // Scan only the last N lines.
    const textToScan = cleanOutput.slice(this.lastLinesOffset(cleanOutput));

    return this.matchPatterns(textToScan);
  }

  /**
   * Detect working state from semantic buffer lines.
   * More efficient when lines are already split and cleaned.
   *
   * @param lines Array of terminal output lines
   * @returns Detection result with working state and confidence
   */
  detectFromLines(lines: string[]): PatternDetectionResult {
    if (!lines || lines.length === 0) {
      return {
        isWorking: false,
        confidence: 0,
        matchTier: "none",
      };
    }

    // Take last N lines
    const scanLines = lines.slice(-this.scanLineCount);

    // Clean each line and join
    const cleanedLines = scanLines.map((line) => stripAnsi(line));
    const textToScan = cleanedLines.join("\n");

    return this.matchPatterns(textToScan);
  }
}

/**
 * Create a pattern detector for the given agent type.
 *
 * @param agentId Agent identifier (e.g., "claude", "gemini", "codex")
 * @param customConfig Optional custom configuration to override defaults
 * @returns Configured pattern detector
 */
export function createPatternDetector(
  agentId?: string,
  customConfig?: PatternDetectionConfig
): AgentPatternDetector {
  return new AgentPatternDetector(agentId, customConfig);
}
