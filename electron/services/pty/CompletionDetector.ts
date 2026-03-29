import { stripAnsi } from "./AgentPatternDetector.js";

export interface CompletionDetectionResult {
  isCompletion: boolean;
  confidence: number;
  extractedCost?: number;
  extractedTokens?: number;
}

const COST_PATTERNS = [
  /Total cost:\s+\$(?<cost>[\d.]+)/,
  /\$(?<cost>\d+\.\d+)\s*·\s*(?<tokens>\d+)\s*tokens/,
];

export function extractCostFromLines(lines: string[]): number | undefined {
  for (const line of lines) {
    const cleanLine = stripAnsi(line);
    for (const pattern of COST_PATTERNS) {
      const match = pattern.exec(cleanLine);
      if (match?.groups?.cost) {
        const cost = parseFloat(match.groups.cost);
        if (Number.isFinite(cost)) return cost;
      }
    }
  }
  return undefined;
}

export function extractTokensFromLines(lines: string[]): number | undefined {
  for (const line of lines) {
    const cleanLine = stripAnsi(line);
    for (const pattern of COST_PATTERNS) {
      const match = pattern.exec(cleanLine);
      if (match?.groups?.tokens) {
        const tokens = parseInt(match.groups.tokens, 10);
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
