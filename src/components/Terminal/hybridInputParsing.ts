export interface AtFileContext {
  atStart: number;
  tokenEnd: number;
  queryRaw: string;
  queryForSearch: string;
}

export function getAtFileContext(text: string, caret: number): AtFileContext | null {
  if (caret < 0 || caret > text.length) return null;
  const beforeCaret = text.slice(0, caret);
  const atStart = beforeCaret.lastIndexOf("@");
  if (atStart === -1) return null;
  if (atStart > 0 && !/\s/.test(beforeCaret[atStart - 1])) return null;

  let tokenEnd = atStart + 1;
  while (tokenEnd < text.length && !/\s/.test(text[tokenEnd])) {
    tokenEnd++;
  }

  if (caret < atStart + 1 || caret > tokenEnd) return null;

  const token = text.slice(atStart + 1, tokenEnd);
  if (/\s/.test(token)) return null;

  const queryRaw = text.slice(atStart + 1, caret);
  const queryForSearch = queryRaw.replace(/^['"]/, "");

  return { atStart, tokenEnd, queryRaw, queryForSearch };
}

export function formatAtFileToken(file: string): string {
  const needsQuotes = /\s/.test(file);
  return `@${needsQuotes ? `"${file}"` : file}`;
}

export interface SlashCommandContext {
  start: number;
  tokenEnd: number;
  query: string;
}

export function getSlashCommandContext(text: string, caret: number): SlashCommandContext | null {
  if (caret < 0 || caret > text.length) return null;
  if (!text.startsWith("/")) return null;
  if (caret < 1) return null;

  const whitespaceMatch = text.slice(1).match(/\s/);
  const tokenEnd = whitespaceMatch ? whitespaceMatch.index! + 1 : text.length;
  if (caret > tokenEnd) return null;

  return { start: 0, tokenEnd, query: text.slice(0, caret) };
}

export interface SlashCommandToken {
  start: number;
  end: number;
  command: string;
}

export function getLeadingSlashCommand(text: string): SlashCommandToken | null {
  if (!text.startsWith("/")) return null;

  const whitespaceMatch = text.slice(1).match(/\s/);
  const tokenEnd = whitespaceMatch ? whitespaceMatch.index! + 1 : text.length;

  if (tokenEnd <= 1) return null;

  return {
    start: 0,
    end: tokenEnd,
    command: text.slice(0, tokenEnd),
  };
}

export interface AtFileToken {
  start: number;
  end: number;
  path: string;
  isQuoted: boolean;
}

export function getAllAtFileTokens(text: string): AtFileToken[] {
  const tokens: AtFileToken[] = [];
  let i = 0;

  while (i < text.length) {
    if (text[i] !== "@") {
      i++;
      continue;
    }

    // Check that @ is at start or preceded by whitespace or common delimiters
    if (i > 0 && !/[\s([{]/.test(text[i - 1])) {
      i++;
      continue;
    }

    const atStart = i;
    i++; // Move past @

    if (i >= text.length) break;

    // Check for quoted path
    const quoteChar = text[i];
    if (quoteChar === '"' || quoteChar === "'") {
      i++; // Move past opening quote
      const pathStart = i;
      // Find closing quote, stopping at newlines to prevent multi-line paths
      while (i < text.length && text[i] !== quoteChar && text[i] !== "\n" && text[i] !== "\r") {
        // Support backslash-escaped quotes
        if (text[i] === "\\" && i + 1 < text.length && text[i + 1] === quoteChar) {
          i += 2; // Skip escaped quote
          continue;
        }
        i++;
      }
      // Only create token if we found the closing quote (not newline or end)
      if (i < text.length && text[i] === quoteChar) {
        const path = text.slice(pathStart, i);
        i++; // Move past closing quote
        if (path.length > 0) {
          // Unescape any escaped quotes in the path
          const unescapedPath = path.replace(new RegExp(`\\\\${quoteChar}`, "g"), quoteChar);
          tokens.push({ start: atStart, end: i, path: unescapedPath, isQuoted: true });
        }
      }
      // If unterminated quote, skip it and continue scanning from next position
    } else {
      // Unquoted path - read until whitespace or common delimiters
      const pathStart = i;
      while (
        i < text.length &&
        !/[\s,;:)}\]]/.test(text[i]) &&
        text[i] !== "\n" &&
        text[i] !== "\r"
      ) {
        i++;
      }
      let path = text.slice(pathStart, i);
      // Trim trailing punctuation that's likely not part of the path
      path = path.replace(/[.,;:!?]+$/, "");
      if (path.length > 0) {
        const actualEnd = atStart + 1 + path.length;
        tokens.push({ start: atStart, end: actualEnd, path, isQuoted: false });
      }
    }
  }

  return tokens;
}
