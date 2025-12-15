export const BRACKETED_PASTE_START = "\u001b[200~";
export const BRACKETED_PASTE_END = "\u001b[201~";

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
  const pasteThresholdChars = options.pasteThresholdChars ?? 200;
  const usedBracketedPaste = normalized.includes("\n") || normalized.length > pasteThresholdChars;
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
