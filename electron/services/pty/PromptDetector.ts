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

// A row that is nothing but a rule: one of those Claude Code draws above and
// below its input row, or the top or bottom edge of an older boxed input.
const COMPOSER_FRAME_ROW = /^\s*[╭╰┌└]?[─━]{3,}[╮╯┐┘]?\s*$/;

/**
 * The row of `lines` that is an agent's input row, empty, inside its frame
 * (#16093). Only the lowest framed region on screen is read, and only when it
 * is a single row: a prompt pattern with nothing typed before or after it.
 * A draft (on one row or several), a selector row ("❯ 1. Yes") or a banner
 * behind a pointer ("❯ You've hit…") there means none, and a frame higher up,
 * such as one quoted in the transcript, is never taken in its place.
 */
export function findEmptyComposerRow(
  lines: readonly string[],
  promptPatterns: readonly RegExp[]
): number | undefined {
  const clean = lines.map((line) => stripAnsi(line));
  let bottom = clean.length - 1;
  while (bottom >= 0 && !COMPOSER_FRAME_ROW.test(clean[bottom]!)) bottom--;
  const rowIndex = bottom - 1;
  if (rowIndex < 1 || !COMPOSER_FRAME_ROW.test(clean[rowIndex - 1]!)) return undefined;
  const row = clean[rowIndex]!.replace(/^\s*[│┃]/, "").replace(/[│┃]\s*$/, "");
  for (const pattern of promptPatterns) {
    const match = row.match(pattern);
    if (
      match?.index !== undefined &&
      match[0].trim().length > 0 &&
      row.slice(0, match.index).trim() === "" &&
      row.slice(match.index + match[0].length).trim() === ""
    ) {
      return rowIndex;
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
