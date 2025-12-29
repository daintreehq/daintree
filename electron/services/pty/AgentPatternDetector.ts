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
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "") // CSI sequences
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "") // OSC sequences
    .replace(/\x1b[()][AB012]/g, "") // Character set designation
    .replace(/\x1b[=>]/g, "") // Keypad mode
    .replace(/\x1b[78]/g, "") // Save/restore cursor
    .replace(/\x1b[DME]/g, "") // Line control
    .replace(/\x1b\[[\d;]*m/g, ""); // SGR (colors/styles) - catch-all
  /* eslint-enable no-control-regex */
}

/**
 * Agent-specific pattern configurations.
 * These patterns are derived from observing actual CLI output.
 */
export const AGENT_PATTERN_CONFIGS: Record<string, PatternDetectionConfig> = {
  claude: {
    primaryPatterns: [
      // Full format with interrupt hint
      /[✽✻✼✾⟡◇◆●○]\s+\w+…?\s+\(esc to interrupt/i,
      // Generic interrupt hint (catches variations)
      /esc to interrupt/i,
    ],
    fallbackPatterns: [
      // Minimal format (just spinner + activity word, no parens)
      /[✽✻✼✾⟡◇◆●○]\s+(thinking|deliberating|working|reading|writing|searching|executing)/i,
    ],
    scanLineCount: 10,
    primaryConfidence: 0.95,
    fallbackConfidence: 0.75,
  },

  gemini: {
    primaryPatterns: [
      // ASCII spinner + text + cancel hint
      /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s+.+\s+\(esc to cancel/i,
      // Generic cancel hint
      /esc to cancel/i,
    ],
    fallbackPatterns: [
      // Just the spinner (Braille dots used by Gemini)
      /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s+\w/,
    ],
    scanLineCount: 10,
    primaryConfidence: 0.95,
    fallbackConfidence: 0.7,
  },

  codex: {
    primaryPatterns: [
      // Full format with interrupt hint
      /[•·]\s+Working\s+\([^)]*esc to interrupt/i,
      // Generic interrupt hint
      /esc to interrupt/i,
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
  primaryPatterns: [/esc to interrupt/i, /esc to cancel/i, /escape to interrupt/i],
  fallbackPatterns: [
    // Common spinner characters followed by activity
    /[✽✻✼✾⟡◇◆●○•·⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s+(thinking|working|loading|processing|running)/i,
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
   * Detect working state from raw terminal output.
   *
   * @param output Raw terminal output (may include ANSI codes)
   * @returns Detection result with working state and confidence
   */
  detect(output: string): PatternDetectionResult {
    if (!output || output.length === 0) {
      return {
        isWorking: false,
        confidence: 0,
        matchTier: "none",
      };
    }

    // Strip ANSI codes for reliable pattern matching
    const cleanOutput = stripAnsi(output);

    // Split into lines and take the last N lines
    const lines = cleanOutput.split("\n");
    const scanLines = lines.slice(-this.scanLineCount);
    const textToScan = scanLines.join("\n");

    // Try primary patterns first (high confidence)
    for (const pattern of this.config.primaryPatterns) {
      const match = textToScan.match(pattern);
      if (match) {
        return {
          isWorking: true,
          confidence: this.config.primaryConfidence ?? 0.95,
          matchTier: "primary",
          matchedText: match[0],
        };
      }
    }

    // Try fallback patterns (medium confidence)
    if (this.config.fallbackPatterns) {
      for (const pattern of this.config.fallbackPatterns) {
        const match = textToScan.match(pattern);
        if (match) {
          return {
            isWorking: true,
            confidence: this.config.fallbackConfidence ?? 0.75,
            matchTier: "fallback",
            matchedText: match[0],
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

    // Reuse main detection logic
    // Try primary patterns first (high confidence)
    for (const pattern of this.config.primaryPatterns) {
      const match = textToScan.match(pattern);
      if (match) {
        return {
          isWorking: true,
          confidence: this.config.primaryConfidence ?? 0.95,
          matchTier: "primary",
          matchedText: match[0],
        };
      }
    }

    // Try fallback patterns (medium confidence)
    if (this.config.fallbackPatterns) {
      for (const pattern of this.config.fallbackPatterns) {
        const match = textToScan.match(pattern);
        if (match) {
          return {
            isWorking: true,
            confidence: this.config.fallbackConfidence ?? 0.75,
            matchTier: "fallback",
            matchedText: match[0],
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
