import { stripAnsi } from "./AgentPatternDetector.js";

export const DEFAULT_PROMPT_PATTERNS = [/^\s*[>›❯⟩$#%]\s*/i];

export interface PromptDetectionResult {
  isPrompt: boolean;
  confidence: number;
  matchedText?: string;
}

export interface PromptDetectorConfig {
  promptPatterns: RegExp[];
  promptHintPatterns: RegExp[];
  promptScanLineCount: number;
  promptConfidence: number;
}

export function detectPrompt(
  lines: string[],
  config: PromptDetectorConfig,
  cursorLine?: string | null,
  options?: { allowHistoryScan?: boolean }
): PromptDetectionResult {
  const { promptPatterns, promptHintPatterns, promptScanLineCount, promptConfidence } = config;

  if (promptPatterns.length === 0 && promptHintPatterns.length === 0) {
    return { isPrompt: false, confidence: 0 };
  }

  const cleanCursor =
    cursorLine !== undefined && cursorLine !== null ? stripAnsi(cursorLine) : null;
  if (cleanCursor !== null) {
    for (const pattern of promptPatterns) {
      const match = cleanCursor.match(pattern);
      if (match) {
        return {
          isPrompt: true,
          confidence: promptConfidence,
          matchedText: match[0],
        };
      }
    }

    for (const pattern of promptHintPatterns) {
      const match = cleanCursor.match(pattern);
      if (match) {
        return {
          isPrompt: true,
          confidence: promptConfidence,
          matchedText: match[0],
        };
      }
    }
  }

  const scanCount = Math.min(promptScanLineCount, lines.length);
  const scanLines = lines.slice(-scanCount);
  for (const line of scanLines) {
    const cleanLine = stripAnsi(line);
    for (const pattern of promptHintPatterns) {
      const match = cleanLine.match(pattern);
      if (match) {
        return {
          isPrompt: true,
          confidence: promptConfidence,
          matchedText: match[0],
        };
      }
    }
  }

  if (cleanCursor && cleanCursor.trim().length > 0 && !options?.allowHistoryScan) {
    return { isPrompt: false, confidence: 0 };
  }

  for (const line of scanLines) {
    const cleanLine = stripAnsi(line);
    for (const pattern of promptPatterns) {
      const match = cleanLine.match(pattern);
      if (match) {
        return {
          isPrompt: true,
          confidence: promptConfidence * 0.8,
          matchedText: match[0],
        };
      }
    }
  }

  return { isPrompt: false, confidence: 0 };
}
