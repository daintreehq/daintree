import { stripAnsi } from "./AgentPatternDetector.js";

export interface CompletionDetectionResult {
  isCompletion: boolean;
  confidence: number;
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
        return { isCompletion: true, confidence: completionConfidence };
      }
    }
  }

  return { isCompletion: false, confidence: 0 };
}
