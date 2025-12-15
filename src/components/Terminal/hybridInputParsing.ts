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

  const firstSpaceIndex = text.indexOf(" ");
  const tokenEnd = firstSpaceIndex === -1 ? text.length : firstSpaceIndex;
  if (caret > tokenEnd) return null;

  return { start: 0, tokenEnd, query: text.slice(0, caret) };
}
