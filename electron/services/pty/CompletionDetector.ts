import { stripAnsi } from "./AgentPatternDetector.js";

export interface CompletionDetectionResult {
  isCompletion: boolean;
  confidence: number;
  extractedCost?: number;
  extractedTokens?: number;
}

// Session-summary wordings observed across agent CLIs. Numbers may be
// comma-grouped ("1,234.56"); `parseSummaryNumber` strips the commas.
// Claude: "Total cost: $0.0123" / status-line "$0.05 · 1234 tokens".
// Codex:  "Token usage: total=8123" / "Token usage: 8,123".
// Gemini: "Total Tokens: 12,345" (/stats table).
const COST_PATTERNS = [
  /Total cost(?:\s*\(USD\))?:\s*\$(?<cost>[\d,]+(?:\.\d+)?)/i,
  /\$(?<cost>[\d,]+\.\d+)\s*[·•|]\s*(?<tokens>[\d,]+)\s*tokens/i,
];

const TOKEN_PATTERNS = [
  /\$(?<cost>[\d,]+\.\d+)\s*[·•|]\s*(?<tokens>[\d,]+)\s*tokens/i,
  /Total tokens:\s*(?<tokens>[\d,]+)/i,
  /Token usage:\s*(?:total[=:]?\s*)?(?<tokens>[\d,]+)/i,
  /\b(?<tokens>[\d,]+)\s+tokens? used\b/i,
];

function parseSummaryNumber(raw: string): number {
  return parseFloat(raw.replace(/,/g, ""));
}

export function extractCostFromLines(lines: string[]): number | undefined {
  for (const line of lines) {
    const cleanLine = stripAnsi(line);
    for (const pattern of COST_PATTERNS) {
      const match = pattern.exec(cleanLine);
      if (match?.groups?.cost) {
        const cost = parseSummaryNumber(match.groups.cost);
        if (Number.isFinite(cost)) return cost;
      }
    }
  }
  return undefined;
}

export function extractTokensFromLines(lines: string[]): number | undefined {
  for (const line of lines) {
    const cleanLine = stripAnsi(line);
    for (const pattern of TOKEN_PATTERNS) {
      const match = pattern.exec(cleanLine);
      if (match?.groups?.tokens) {
        const tokens = Math.trunc(parseSummaryNumber(match.groups.tokens));
        if (Number.isFinite(tokens)) return tokens;
      }
    }
  }
  return undefined;
}

export function detectCompletion(
  lines: string[],
  completionPatterns: RegExp[],
  completionConfidence: number,
  scanLineCount: number
): CompletionDetectionResult {
  if (completionPatterns.length === 0) {
    return { isCompletion: false, confidence: 0 };
  }

  const scanCount = Math.min(scanLineCount, lines.length);
  const scanLines = lines.slice(-scanCount);
  for (const line of scanLines) {
    const cleanLine = stripAnsi(line);
    for (const pattern of completionPatterns) {
      if (pattern.test(cleanLine)) {
        const extractedCost = extractCostFromLines(scanLines);
        const extractedTokens = extractTokensFromLines(scanLines);
        return {
          isCompletion: true,
          confidence: completionConfidence,
          extractedCost,
          extractedTokens,
        };
      }
    }
  }

  return { isCompletion: false, confidence: 0 };
}
