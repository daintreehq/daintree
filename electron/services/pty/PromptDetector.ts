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
  // Strip each scan line once and reuse in the history loop below — this
  // runs on the 50ms polling tick, and both loops scan the same lines.
  const cleanScanLines: string[] = [];
  for (const line of scanLines) {
    const cleanLine = stripAnsi(line);
    cleanScanLines.push(cleanLine);
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

  for (const cleanLine of cleanScanLines) {
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

// The frame around an agent's input row: the rules Claude Code draws above and
// below it, or the top and bottom edges of an older boxed input.
const COMPOSER_FRAME_ROW = /^\s*[╭╰┌└]?[─━]{3,}/;

/**
 * The row of `lines` that is an agent's input row, empty, inside its frame
 * (#16093), searched from the bottom: a prompt pattern with nothing typed
 * after it, and a frame row directly above and below. A draft, a selector row
 * ("❯ 1. Yes") and a banner behind a pointer ("❯ You've hit…") are never one,
 * and a screen with no such row has none.
 */
export function findEmptyComposerRow(
  lines: readonly string[],
  promptPatterns: readonly RegExp[]
): number | undefined {
  const clean = lines.map((line) => stripAnsi(line));
  for (let i = clean.length - 2; i >= 1; i--) {
    if (!COMPOSER_FRAME_ROW.test(clean[i - 1]!) || !COMPOSER_FRAME_ROW.test(clean[i + 1]!)) {
      continue;
    }
    const row = clean[i]!.replace(/^\s*[│┃]/, "").replace(/[│┃]\s*$/, "");
    for (const pattern of promptPatterns) {
      const match = row.match(pattern);
      if (
        match?.index !== undefined &&
        match[0].trim().length > 0 &&
        row.slice(0, match.index).trim() === "" &&
        row.slice(match.index + match[0].length).trim() === ""
      ) {
        return i;
      }
    }
  }
  return undefined;
}

const LEXEME_BRACKET_CONFIRM = /[[(]\s*[yY](?:es)?\s*\/\s*[nN](?:o)?\s*[\])]/;
const LEXEME_TRAILING_QUESTION = /\?\s*$/;
const LEXEME_KEYWORD_COLON =
  /(?:password|passphrase|username|token|host|enter|select|choose|confirm|input)\s*:\s*$/i;
const LEXEME_PRESS_CONTINUE = /press\s+(?:any|return|enter)\s+/i;

const PROMPT_LEXEME_PATTERNS = [
  LEXEME_BRACKET_CONFIRM,
  LEXEME_TRAILING_QUESTION,
  LEXEME_KEYWORD_COLON,
  LEXEME_PRESS_CONTINUE,
];

export function detectPromptLexeme(line: string): PromptDetectionResult {
  const clean = stripAnsi(line).trim();
  if (clean.length === 0) {
    return { isPrompt: false, confidence: 0 };
  }

  for (const pattern of PROMPT_LEXEME_PATTERNS) {
    const match = clean.match(pattern);
    if (match) {
      return { isPrompt: true, confidence: 0.7, matchedText: match[0] };
    }
  }

  return { isPrompt: false, confidence: 0 };
}
