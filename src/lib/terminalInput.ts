import {
  BRACKETED_PASTE_START,
  BRACKETED_PASTE_END,
  shouldUseBracketedPaste,
  PASTE_THRESHOLD_CHARS,
} from "../../shared/utils/terminalInputProtocol.js";

export { BRACKETED_PASTE_START, BRACKETED_PASTE_END };

export interface TerminalSendPayload {
  data: string;
  trackerData: string;
  usedBracketedPaste: boolean;
}

function normalizeText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function buildTerminalSendPayload(
  text: string,
  options: {
    execute?: boolean;
    pasteThresholdChars?: number;
  } = {}
): TerminalSendPayload {
  const normalized = normalizeText(text);
  const execute = options.execute ?? true;
  const pasteThresholdChars = options.pasteThresholdChars ?? PASTE_THRESHOLD_CHARS;
  const usedBracketedPaste = shouldUseBracketedPaste(normalized, pasteThresholdChars);
  const trackerData = execute ? `${normalized}\r` : normalized;

  if (!usedBracketedPaste) {
    return {
      data: trackerData,
      trackerData,
      usedBracketedPaste,
    };
  }

  return {
    data: `${BRACKETED_PASTE_START}${normalized}${BRACKETED_PASTE_END}${execute ? "\r" : ""}`,
    trackerData,
    usedBracketedPaste,
  };
}
