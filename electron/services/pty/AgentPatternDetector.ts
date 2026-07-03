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

import { getEffectiveAgentConfig } from "../../../shared/config/agentRegistry.js";
import { buildPatternConfig } from "./terminalActivityPatterns.js";

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
  // Every pattern below requires a literal ESC; skip all passes when absent.
  if (!text.includes("\x1b")) {
    return text;
  }
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
 * Universal patterns that work across all agents.
 * Used when agent-specific patterns aren't configured.
 *
 * The interrupt-hint alternation covers the wordings shipped by the agents in
 * `shared/config/agents/`: "esc to interrupt" (Claude/Codex), "esc to cancel"
 * (Gemini/Copilot), "escape to interrupt", "esc again to interrupt/cancel"
 * (OpenCode), "esc to stop" (Cursor), and "Ctrl+C to interrupt" (Goose).
 */
const INTERRUPT_HINT = String.raw`(?:esc|escape|ctrl\+c)(?:\s+again)?\s+to\s+(?:interrupt|cancel|stop)`;

export const UNIVERSAL_PATTERN_CONFIG: PatternDetectionConfig = {
  primaryPatterns: [
    // Full format: status marker + text + parenthesised interrupt hint
    // (marker superset: Claude v2.1.79 chars + legacy + Codex/Cursor dots +
    // Gemini/Goose/OpenCode braille U+2800–U+28FF).
    new RegExp(
      String.raw`[·*✢✳✶✻✽●✼✾⟡◇◆○•∙∘◉⠀-⣿]\s+[^()\n]{2,80}\s*\((?:[^()\n]*?\s)?${INTERRUPT_HINT}`,
      "i"
    ),
    // Simple: interrupt hint near end of line (handles long/wrapped text).
    // Two tail shapes: a short tail with optional close-paren ("· 15s)"), or
    // a longer tail that MUST end in ")" — covers wrapped status rows carrying
    // time + token counters ("esc to interrupt · 123s · ↓ 4.2k tokens)").
    // Prose that mentions the escape key keeps talking past the hint with no
    // closing paren, so an unbounded tail is what made sentences ending in
    // "esc to cancel the dialog works." register as working.
    new RegExp(String.raw`${INTERRUPT_HINT}(?:[^)\n]{0,20}\)?|[^)\n]{0,60}\))$`, "im"),
    // Time + hint structures: "(15s · esc to interrupt)", "(14s, esc to cancel)"
    new RegExp(String.raw`\(\d+[smh]?\s*[·•∙⋅,]?\s*${INTERRUPT_HINT}`, "i"),
  ],
  fallbackPatterns: [
    // Common spinner characters followed by activity
    /[✢✳✶✻✽●•◐◓◑◒⠀-⣿]\s+(thinking|working|loading|processing|running|generating|analyzing|reasoning|searching|compacting)/i,
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
    } else {
      // Resolve the agent's registry detection config directly. The registry
      // is the single source of truth for per-agent patterns — a hardcoded
      // per-agent copy here used to shadow it and drift (the two disagreed on
      // nothing today only by discipline). Unknown agents fall back to the
      // universal config.
      const detection = agentId ? getEffectiveAgentConfig(agentId)?.detection : undefined;
      this.config =
        (detection ? buildPatternConfig(detection, agentId) : undefined) ??
        UNIVERSAL_PATTERN_CONFIG;
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

    const result = this.matchPatterns(textToScan);
    if (result.isWorking || cleanedLines.length < 2) {
      return result;
    }

    // Wrapped-line rescan: a status line that soft-wrapped mid-word across
    // visual rows ("…esc to inte" / "rrupt · 15s)") can't match on any single
    // row. Concatenating rows without a separator reassembles it; only a real
    // wrap produces a cross-row phrase, so the false-positive surface is
    // negligible.
    return this.matchPatterns(cleanedLines.join(""));
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
