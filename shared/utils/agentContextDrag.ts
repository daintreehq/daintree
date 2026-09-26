/**
 * The contract a plugin view uses to hand a piece of work to an agent terminal
 * by drag and drop, and the text that lands in the agent's draft when it does.
 *
 * Pure and dependency-free on purpose: it ships in `@daintreehq/plugin-sdk`,
 * where a view with no build step reads it as documentation and writes the
 * same JSON by hand, and it is the one place the renderer and the host agree on
 * what a payload may hold and how it reads once drafted.
 */

/**
 * The `dataTransfer` type an agent-context drag carries.
 *
 * Lowercase because Chromium lowercases custom types on the way in, so a
 * mixed-case constant would never match what `types` reports back.
 */
export const AGENT_CONTEXT_DRAG_MIME = "application/x-daintree-agent-context";

/** Longest `text` a payload may carry, in UTF-16 code units. */
export const AGENT_CONTEXT_MAX_TEXT_LENGTH = 32_768;
/** Longest `title`, after trimming. */
export const AGENT_CONTEXT_MAX_TITLE_LENGTH = 120;
/** Longest `source.label`, after trimming. */
export const AGENT_CONTEXT_MAX_SOURCE_LABEL_LENGTH = 80;

/**
 * Anything longer than this is refused before it is parsed. A JSON string
 * escape can take six characters per code unit, so a legitimate payload at the
 * text limit stays well under it; an arbitrary page cannot make the drop
 * handler parse megabytes.
 */
const MAX_SERIALIZED_LENGTH = AGENT_CONTEXT_MAX_TEXT_LENGTH * 6 + 4_096;

/**
 * What a drag hands an agent: a piece of text for the user to instruct the
 * agent about. It lands in the agent's draft as quoted material and is never
 * submitted — the user adds their own instruction and presses Enter.
 */
export interface AgentContextDragPayload {
  /** Payload version. Only `1` exists. */
  v: 1;
  /** Short heading shown above the text, e.g. a card title. At most 120 characters. */
  title?: string;
  /** The content itself. Non-empty, at most 32,768 characters. */
  text: string;
  /** Where it came from, shown beside the title (e.g. `{ label: "Kanban" }`). */
  source?: { label?: string };
}

/**
 * The slice of `DataTransfer` the SDK helper writes to. Structural so the
 * helper type-checks without the DOM library and accepts a test double.
 */
export interface AgentContextDataTransfer {
  setData(format: string, data: string): void;
  effectAllowed: string;
}

/**
 * Newlines normalised to `\n`; every other C0/C1 control character except tab
 * removed. The text is quoted into a draft the user will submit to a terminal,
 * where an ESC or ETX would act on the line discipline before any program sees
 * it, so these are dropped rather than carried.
 */
function normalizeText(text: string): string {
  const unified = text.replace(/\r\n?/g, "\n");
  let out = "";
  for (let i = 0; i < unified.length; i++) {
    const code = unified.charCodeAt(i);
    if (code === 0x0a || code === 0x09) {
      out += unified[i];
      continue;
    }
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) continue;
    out += unified[i];
  }
  return out;
}

/**
 * A single display line: controls and runs of whitespace collapse to one
 * space, then trimmed. Empty reads as absent.
 */
function normalizeLine(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    const isControl = code <= 0x1f || (code >= 0x7f && code <= 0x9f);
    out += isControl ? " " : value[i];
  }
  return out.replace(/\s+/g, " ").trim();
}

/**
 * Validate and normalise an untrusted payload, or `null` when it is not one.
 *
 * Strict about shape and size — a wrong version, a missing or blank `text`, an
 * over-long field or a non-string where a string belongs rejects the whole
 * payload rather than trimming it to fit, because a partial handoff is the one
 * outcome a user cannot tell from a complete one. Unknown extra keys are
 * ignored, never read.
 */
export function validateAgentContextPayload(value: unknown): AgentContextDragPayload | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.v !== 1) return null;

  if (typeof record.text !== "string") return null;
  if (record.text.length > AGENT_CONTEXT_MAX_TEXT_LENGTH) return null;
  const text = normalizeText(record.text);
  if (text.trim().length === 0) return null;

  let title: string | undefined;
  if (record.title !== undefined) {
    if (typeof record.title !== "string") return null;
    const normalized = normalizeLine(record.title);
    if (normalized.length > AGENT_CONTEXT_MAX_TITLE_LENGTH) return null;
    if (normalized.length > 0) title = normalized;
  }

  let label: string | undefined;
  if (record.source !== undefined) {
    const source = record.source;
    if (typeof source !== "object" || source === null || Array.isArray(source)) return null;
    const rawLabel = (source as Record<string, unknown>).label;
    if (rawLabel !== undefined) {
      if (typeof rawLabel !== "string") return null;
      const normalized = normalizeLine(rawLabel);
      if (normalized.length > AGENT_CONTEXT_MAX_SOURCE_LABEL_LENGTH) return null;
      if (normalized.length > 0) label = normalized;
    }
  }

  return {
    v: 1,
    text,
    ...(title !== undefined ? { title } : {}),
    ...(label !== undefined ? { source: { label } } : {}),
  };
}

/**
 * Serialise a payload for `dataTransfer.setData`. Throws a `TypeError` naming
 * the problem when the payload would be refused at the drop, so an author finds
 * out at `dragstart` rather than from a drop that silently does nothing.
 */
export function encodeAgentContextDragPayload(payload: AgentContextDragPayload): string {
  const valid = validateAgentContextPayload(payload);
  if (valid === null) {
    throw new TypeError(
      `Invalid agent context payload: expected { v: 1, text } with non-blank text of at most ${AGENT_CONTEXT_MAX_TEXT_LENGTH} characters, an optional title of at most ${AGENT_CONTEXT_MAX_TITLE_LENGTH} and an optional source.label of at most ${AGENT_CONTEXT_MAX_SOURCE_LABEL_LENGTH}`
    );
  }
  return JSON.stringify(valid);
}

/**
 * Read a serialised payload back, or `null` if it is not a valid one. The
 * string is untrusted — anything that can start a drag can set this type — so
 * it is parsed defensively and validated in full.
 */
export function decodeAgentContextDragPayload(serialized: string): AgentContextDragPayload | null {
  if (typeof serialized !== "string" || serialized.length === 0) return null;
  if (serialized.length > MAX_SERIALIZED_LENGTH) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    return null;
  }
  return validateAgentContextPayload(parsed);
}

/**
 * Put `payload` on a drag: the agent-context type, plus `text/plain` so a drop
 * anywhere else (an editor, another app) still receives the text. Call it from
 * `dragstart`. Throws on an invalid payload, like
 * {@link encodeAgentContextDragPayload}.
 */
export function setAgentContextDragData(
  dataTransfer: AgentContextDataTransfer,
  payload: AgentContextDragPayload
): void {
  const serialized = encodeAgentContextDragPayload(payload);
  dataTransfer.setData(AGENT_CONTEXT_DRAG_MIME, serialized);
  dataTransfer.setData("text/plain", payload.text);
  dataTransfer.effectAllowed = "copy";
}

/**
 * The fence for `text`: backticks, one longer than the longest run inside it
 * and never fewer than three, so content carrying its own fenced block cannot
 * close the quote early.
 */
export function backtickFenceFor(text: string): string {
  let longest = 0;
  let run = 0;
  for (const char of text) {
    run = char === "`" ? run + 1 : 0;
    if (run > longest) longest = run;
  }
  return "`".repeat(Math.max(3, longest + 1));
}

/**
 * A heading part cut to `max` characters on one line. Truncated rather than
 * refused: the source label can be a plugin's display name, which the manifest
 * does not bound, and a long name is no reason to lose the handoff.
 */
function boundedLine(value: string | undefined, max: number): string {
  const line = normalizeLine(value ?? "");
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
}

/**
 * The info string on a handoff block's opening fence. It is what marks the
 * block as a handoff — to the agent reading it, and to the input bar, which
 * keeps exactly these blocks literal on submit and leaves every other fence the
 * user writes alone. A line with an info string can never close a fence, so the
 * opener cannot be swallowed by one the user left open above it.
 */
export const AGENT_CONTEXT_FENCE_INFO = "daintree-context";

/**
 * The block a payload becomes in an agent's draft: a fenced block, tagged
 * `daintree-context`, whose first line is the heading (`Label: Title`) and
 * whose body is the text.
 *
 * Everything — heading included — sits inside the fence, and the fence is one
 * backtick longer than any run in what it holds, so no line of the content can
 * close it. That is what keeps the handoff literal all the way to the agent:
 * the input bar does not expand `@diff`, `@terminal` or `@selection` inside a
 * handoff block, so a card that mentions one is quoted, never resolved into
 * the user's diff.
 *
 * Every part is normalised here, whatever path it arrived by — control
 * characters dropped, the heading bounded to one line — so nothing reaches a
 * draft unsanitised even if a caller skipped validation.
 */
export function formatAgentContextBlock(payload: {
  text: string;
  title?: string;
  sourceLabel?: string;
}): string {
  const text = normalizeText(payload.text)
    .slice(0, AGENT_CONTEXT_MAX_TEXT_LENGTH)
    .replace(/\n+$/, "");
  const heading = [
    boundedLine(payload.sourceLabel, AGENT_CONTEXT_MAX_SOURCE_LABEL_LENGTH),
    boundedLine(payload.title, AGENT_CONTEXT_MAX_TITLE_LENGTH),
  ]
    .filter(Boolean)
    .join(": ");
  const content = heading ? `${heading}\n\n${text}` : text;
  const fence = backtickFenceFor(content);
  return `${fence}${AGENT_CONTEXT_FENCE_INFO}\n${content}\n${fence}`;
}

/**
 * The line that closes a fence `text` leaves open at its end, by CommonMark's
 * rules (an opener of three or more backticks or tildes indented at most three
 * spaces; a closer of the same character at least as long with nothing after
 * it), or `null` when every fence is closed.
 */
export function closingFenceForOpenBlock(text: string): string | null {
  let open: { char: string; length: number } | null = null;
  for (const line of text.split("\n")) {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!match) continue;
    const run = match[1]!;
    const rest = match[2]!;
    if (open === null) {
      // A backtick fence's info string may not contain a backtick.
      if (!(run[0] === "`" && rest.includes("`"))) open = { char: run[0]!, length: run.length };
    } else if (run[0] === open.char && run.length >= open.length && rest.trim() === "") {
      open = null;
    }
  }
  return open === null ? null : open.char.repeat(open.length);
}

/**
 * Append a context block to an existing draft. Never replaces or trims what is
 * there — trailing spaces and blank lines the user left stay exactly as typed —
 * and only adds the line breaks needed to start the block on its own line after
 * a blank one. A fence the draft leaves open is closed first, on its own line,
 * so the handoff never lands inside the user's code block. Ends on a fresh line
 * so the caret, parked at the end, is ready for the user's instruction.
 */
export function appendAgentContextToDraft(draft: string, block: string): string {
  if (draft.length === 0) return `${block}\n`;
  const closer = closingFenceForOpenBlock(draft);
  const kept = closer === null ? draft : `${draft}${draft.endsWith("\n") ? "" : "\n"}${closer}`;
  const separator = kept.endsWith("\n\n") ? "" : kept.endsWith("\n") ? "\n" : "\n\n";
  return `${kept}${separator}${block}\n`;
}

/**
 * Character ranges `[start, end)` of the handoff blocks in `text`: from a line
 * that is a backtick fence tagged `daintree-context` to the next line that is
 * exactly that fence. Matched on that pair alone, not by tracking every fence
 * in the draft, so what the user writes around the block — an unclosed fence
 * above it included — cannot move its edges; nothing inside can end it early
 * either, because its fence is longer than any backtick run it holds. A block
 * whose closing line was deleted runs to the end, staying literal.
 */
export function agentContextBlockRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const opener = new RegExp(`^(\`{3,})${AGENT_CONTEXT_FENCE_INFO}$`);
  let open: { start: number; fence: string } | null = null;
  let offset = 0;
  for (const line of text.split("\n")) {
    const lineEnd = offset + line.length;
    if (open === null) {
      const match = opener.exec(line);
      if (match) open = { start: offset, fence: match[1]! };
    } else if (line === open.fence) {
      ranges.push([open.start, lineEnd]);
      open = null;
    }
    offset = lineEnd + 1;
  }
  if (open !== null) ranges.push([open.start, text.length]);
  return ranges;
}

/**
 * The source label a host call drafts under: the plugin's display name, which
 * comes from its manifest and is not otherwise bounded. Normalised to one line
 * and cut to the label limit, like a drag's `source.label`.
 */
export function sanitizeAgentContextSourceLabel(label: string): string {
  return boundedLine(label, AGENT_CONTEXT_MAX_SOURCE_LABEL_LENGTH);
}
