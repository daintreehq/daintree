/**
 * The refusals Claude Code 2.1.328 prints for `/restart` (#17908), read from
 * its shipped binary. Each opens one message; the rest of it (a path, a
 * version) varies, so a line is reported as it was drawn, never rebuilt from
 * these.
 */
export const CLAUDE_RESTART_REFUSAL_HEADS = [
  "Can't restart automatically.",
  "Can't restart while work is running in the background.",
  "Can't restart while Remote Control is connected.",
  "Can't restart this session. It isn't saved to disk,",
  "Can't restart this session here.",
  "Can't restart. The installed version wasn't found.",
  "Can't restart on the installed version.",
] as const;

// Every refusal above opens this way, and a later build's new one will too.
// Either apostrophe: Claude's copy uses the straight one, but a terminal font
// or a future string may not.
const REFUSAL_HEAD = /^Can[’']t restart\b/;

// A command's result hangs off its echo under this gutter, sometimes inside a
// box edge. Not the reply glyph: an agent's own sentence there is no refusal.
const GUTTER = /^[\s│┃]*(?:⎿\s*)?/;

// A row Claude draws for something else: its prompt, a reply, a rule or a
// status glyph. Never the next part of a wrapped message.
const NOT_CONTINUATION = /^\s*(?:[⎿⏺●❯>✻✽✶✳✢·│┃╭╰]|[─━═]{3})/;

function leadingSpaces(row: string): number {
  return row.length - row.trimStart().length;
}

/**
 * The first `/restart` refusal in `text`, as drawn: its opening row from the
 * refusal's first word, joined with the rows Claude wrapped it onto. Null when
 * no row opens with one.
 */
export function findClaudeRestartRefusal(text: string): string | null {
  const rows = text.split("\n");
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const gutter = GUTTER.exec(row)?.[0] ?? "";
    const message = row.slice(gutter.length);
    if (!REFUSAL_HEAD.test(message)) continue;
    const parts = [message.trim()];
    // Claude wraps a long message onto rows indented to its first word; a
    // terminal's own soft wrap already arrives joined.
    const column = gutter.length;
    for (let j = i + 1; j < rows.length; j++) {
      const next = rows[j]!;
      if (next.trim() === "" || NOT_CONTINUATION.test(next)) break;
      if (leadingSpaces(next) !== column) break;
      parts.push(next.trim());
    }
    return parts.join(" ");
  }
  return null;
}
