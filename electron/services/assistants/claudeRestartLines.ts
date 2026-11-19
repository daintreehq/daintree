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

// Claude's copy uses the straight apostrophe; a terminal font or a later
// string may not.
const normalizeApostrophe = (text: string) => text.replace(/’/g, "'");

// Under the result gutter, any `Can't restart` opens a refusal, a later
// build's new one included. Without it only a known head does: a transcript
// row can open the same way.
const REFUSAL_HEAD = /^Can't restart\b/;
const KNOWN_HEADS = CLAUDE_RESTART_REFUSAL_HEADS.map(normalizeApostrophe);

// A command's result hangs off its echo under this gutter, sometimes inside a
// box edge. Not the reply glyph: an agent's own sentence there is no refusal.
const EDGE = /^[\s│┃]*/;
const GUTTER = /^[\s│┃]*⎿\s*/;

// The command as the transcript echoes it, at the prompt glyph.
const ECHO = /^[\s│┃]*[❯>]\s*\/restart\s*$/;

// The composer's top edge: a rule with the prompt row under it. Rows from
// there down are the input, where a person's draft can read `/restart` too.
const RULE = /^[\s╭╰─━═╮╯]*[─━═]{8}[\s─━═╮╯]*$/;
const PROMPT_ROW = /^\s*(?:[│┃]\s*)?[❯>](?:\s|$)/;

function transcriptEnd(rows: readonly string[]): number {
  for (let i = rows.length - 2; i >= 0; i--) {
    if (RULE.test(rows[i]!) && PROMPT_ROW.test(rows[i + 1]!)) return i;
  }
  return rows.length;
}

// A row Claude draws for something else: its prompt, a reply, a rule or a
// status glyph. Never the next part of a wrapped message.
const NOT_CONTINUATION = /^[\s│┃]*(?:[⎿⏺●❯>✻✽✶✳✢·╭╰]|[─━═]{3})/;

/**
 * The first `/restart` refusal in `text` below its last echo of the command
 * and above the composer, as drawn: its opening row from the refusal's first
 * word, joined with the rows Claude wrapped it onto. Rows above the echo
 * answered something else. Null when no row opens with one.
 */
export function findClaudeRestartRefusal(text: string): string | null {
  const all = text.split("\n");
  const rows = all.slice(0, transcriptEnd(all));
  let from = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (ECHO.test(rows[i]!)) {
      from = i + 1;
      break;
    }
  }
  for (let i = from; i < rows.length; i++) {
    const row = rows[i]!;
    const gutter = GUTTER.exec(row)?.[0];
    const lead = gutter ?? EDGE.exec(row)?.[0] ?? "";
    const message = row.slice(lead.length);
    const normalized = normalizeApostrophe(message);
    const opens =
      gutter !== undefined
        ? REFUSAL_HEAD.test(normalized)
        : KNOWN_HEADS.some((head) => normalized.startsWith(head));
    if (!opens) continue;
    const parts = [message.trim()];
    // Claude wraps a long message onto rows indented to its first word; a
    // terminal's own soft wrap already arrives joined.
    for (let j = i + 1; j < rows.length; j++) {
      const next = rows[j]!;
      if (next.trim() === "" || NOT_CONTINUATION.test(next)) break;
      const edge = EDGE.exec(next)?.[0] ?? "";
      if (edge.length !== lead.length) break;
      parts.push(next.slice(edge.length).trim());
    }
    return parts.join(" ");
  }
  return null;
}
