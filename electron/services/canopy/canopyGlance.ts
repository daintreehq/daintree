import type { CanopyGlance } from "../../../shared/types/ipc/canopy.js";

/**
 * What a run's screen says at a glance, lifted verbatim with no model: the
 * agent's own recap, its newest report, the step it is on, the command an
 * approval would run. Read on every screen read, background included, so a
 * row has real words the moment the panel opens, before any reader has
 * written its card — and keeps them when the readers are slow or fail.
 *
 * Every field is screen text, never a reading: a line is picked by its shape,
 * not by understanding it, and the readers' words replace it once they land.
 */
export type { CanopyGlance };

export const EMPTY_GLANCE: CanopyGlance = { recap: null, said: null, doing: null, action: null };

/** Longest glance text kept; longer is cut at a sentence or word. */
const GLANCE_CHARS = 220;

const RECAP = /^※\s*recap:\s*(.+)$/i;
const RECAP_TAIL = /\s*\((?:disable recaps\b[^)]*\)?|[^)]*recaps[^)]*\))\s*$/i;
/** The user's message echoed back: Claude's ❯, Codex's ›, the > of Gemini and its kin. */
const ECHO = /^(?:❯|›|>)\s+\S/;
/** A menu's cursor on its selected option ("› 1. Yes, proceed"), which is not the user's message. */
const MENU_CURSOR = /^(?:❯|›|>)\s+\d+[.)]\s/;
/** npm's script banner in tool output, which opens with a `>` nobody typed. */
const NPM_BANNER = /^>\s+\S+@\S+\s+\S+/;
/** A message the agent writes opens on its bullet: Claude's ⏺, Codex's •, Gemini's ✦. */
const BULLET = /^(?:(?:⏺|•|✦|●)\s*)+(.*)$/;
/** Tool output hangs off its call on a branch. */
const BRANCH = /^(?:⎿|└|├)/;
/**
 * A bullet that is a tool call rather than words to the user: Claude's
 * `Bash(npm test)` and `Reading 2 files…`, Codex's `Ran …` / `Edited …` /
 * `Explored`, and the like.
 */
const TOOL_CALL =
  /^(?:[A-Z][A-Za-z]*\(|(?:Ran|Running|Explored|Exploring|Waited|Waiting for|Called|Calling|Starting MCP|Updated Plan)\b|(?:Read|Reading|Searched|Searching|Listed|Listing|Wrote|Writing|Fetched|Fetching)(?: for)? \d+ |(?:Edited|Editing|Added|Adding|Deleted|Deleting|Updated|Updating|Read|Wrote|Created|Creating)\s+\S*[./]\S*(?:\s+\(\+\d+ -\d+\))?\s*$)|\(ctrl\+o to expand\)/;
/** Fixed hints an open dialog or the input box draws beneath itself. */
const HINT =
  /^(?:Press enter to confirm|Enter to select|Esc to cancel|Queued follow-up|\? \d+ question|.*\bshift\+\S+ to answer\b|.*\(esc to interrupt\)|.*· \/ps to view)/i;
/** A spinner or timer that says the agent is working: "(12s · esc to interrupt)". */
const SPINNER =
  /^(?:[✻✶✢✳✽✺·*•⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏◐◓◑◒]\s+)?(.+?)…?\s*\((?:\d[^)]*)?(?:esc to (?:interrupt|cancel)|thinking|thought for)[^)]*(?:\)(?:\s*[·•].*)?|…)\s*$/;
/** Claude's spinner word alone ("✻ Channeling…"), which only says it is busy. */
const BARE_SPINNER = /^[✻✶✢✳✽✺·*]\s+\S+…\s*$/;
/** Where a turn ended: "✻ Worked for 1m 3s · done", Codex's "Worked for 21s • 08:54". */
const TURN_END = /^(?:[✻✶✢✳✽✺·*]\s+)?\S+ for \d[\dhms ]*(?:\s*[·•].*)?$/;
/** An item a Claude checklist marks in progress. */
const TODO_CURRENT = /^(?:⎿\s*)?(?:◼|▣)\s+(\S.*)$/;
const LIST_ITEM = /^(?:[-*+]\s|\d+[.)]\s|\[[ x]\]\s)/;
const COMMAND = /^\$\s+(\S.*)$/;
/** A dialog's first choice, cursor or not: "› 1. Yes, proceed (y)", "1. Yes". */
const DIALOG_CHOICE = /^(?:[›❯>]\s*)?1[.)]\s+\S/;
/** A tool call still running: Claude's `Bash(…)`, or an -ing verb ("Running …", "Reading 1 file…"). */
const IN_PROGRESS = /^(?:[A-Z][A-Za-z]*\(|[A-Z][a-z]+ing\b)/;

/**
 * Longest stretch of a line the shape tests look at. A logical line can be
 * long, and these run on every row of every screen read; a row's shape is
 * decided by how it opens.
 */
const PROBE_CHARS = 300;

export function glanceScreen(lines: readonly string[]): CanopyGlance {
  const rows = lines.map((line) => line.trim());
  let request = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (ECHO.test(rows[i]!) && !NPM_BANNER.test(rows[i]!) && !MENU_CURSOR.test(rows[i]!)) {
      request = i;
      break;
    }
  }
  const said = findSaid(rows, request);
  return {
    recap: findRecap(rows, request),
    said,
    // With nothing the agent said in view, the call it last finished is the
    // best word on what it is doing: it just ran the tests, just staged a file.
    doing: findDoing(rows, request) ?? (said === null ? lastToolCall(rows, request) : null),
    action: findAction(rows, request),
  };
}

function findRecap(rows: readonly string[], request: number): string | null {
  for (let i = rows.length - 1; i > request; i--) {
    const match = RECAP.exec(rows[i]!);
    if (match) return clipText(match[1]!.replace(RECAP_TAIL, ""));
  }
  return null;
}

interface Block {
  /** What opens it: a message, a tool call, tool output, or a row whose opener is above the screen. */
  kind: "message" | "tool" | "output" | "other" | "cut";
  start: number;
  end: number;
}

/**
 * The screen below the newest request, cut into the blocks an agent draws: a
 * message or a tool call opens on a bullet and runs until the next bullet,
 * branch, echo or status line; rows above the first opener belong to a block
 * that began above the screen.
 */
function blocks(rows: readonly string[], from: number): Block[] {
  const out: Block[] = [];
  let current: Block | null = null;
  for (let i = from; i < rows.length; i++) {
    const row = rows[i]!.slice(0, PROBE_CHARS);
    const bullet = BULLET.exec(row);
    let kind: Block["kind"] | null = null;
    if (bullet && HINT.test(bullet[1]!)) kind = "other";
    else if (bullet) kind = TOOL_CALL.test(bullet[1]!) || SPINNER.test(row) ? "tool" : "message";
    else if (BRANCH.test(row)) kind = "output";
    else if (
      ECHO.test(row) ||
      SPINNER.test(row) ||
      BARE_SPINNER.test(row) ||
      TURN_END.test(row) ||
      RECAP.test(row) ||
      HINT.test(row)
    ) {
      kind = "other";
    }
    if (kind !== null) {
      if (current) out.push(current);
      current = { kind, start: i, end: i };
    } else if (current) {
      current.end = i;
    } else if (row !== "") {
      current = { kind: "cut", start: i, end: i };
    }
  }
  if (current) out.push(current);
  return out;
}

/**
 * The opening of the agent's newest message: its first paragraph, or — when
 * its bullet scrolled off the top — the first whole paragraph still on
 * screen. Codex writes one bullet per paragraph, so a run of message bullets
 * is one message, read from its first.
 */
function findSaid(rows: readonly string[], request: number): string | null {
  const found = blocks(rows, request + 1);
  // With nothing on screen the agent drew as its own — no message, no tool
  // call, no line ending a turn — loose rows are a banner's greeting or a
  // tip, not a report.
  const drawn =
    found.some((block) => block.kind !== "cut" && block.kind !== "other") ||
    rows.slice(request + 1).some((row) => TURN_END.test(row));
  if (!drawn) return null;
  let last = -1;
  for (let i = found.length - 1; i >= 0; i--) {
    if (found[i]!.kind === "message" || found[i]!.kind === "cut") {
      last = i;
      break;
    }
  }
  if (last === -1) return null;
  let first = last;
  while (first > 0 && found[first - 1]!.kind === "message" && found[first]!.kind === "message") {
    first--;
  }
  const block = found[first]!;
  const paragraphs: string[][] = [[]];
  for (let i = block.start; i <= block.end; i++) {
    const row = i === block.start ? rows[i]!.replace(BULLET, "$1") : rows[i]!;
    if (row === "") {
      if (paragraphs[paragraphs.length - 1]!.length > 0) paragraphs.push([]);
    } else {
      paragraphs[paragraphs.length - 1]!.push(row);
    }
  }
  const whole = paragraphs.filter((paragraph) => paragraph.length > 0);
  // A block cut by the screen's top edge may open mid-thought, mid-list or
  // inside a tool's output: the first paragraph that opens and ends like
  // prose is taken.
  const pick =
    block.kind === "cut"
      ? whole.find(
          (paragraph) =>
            /^[A-Z"'`(]/.test(paragraph[0]!) &&
            !LIST_ITEM.test(paragraph[0]!) &&
            /[.!?:]$/.test(paragraph[paragraph.length - 1]!) &&
            !/\(ctrl\+\w to expand\)|\+\d+ lines/.test(paragraph.join(" "))
        )
      : whole[0];
  if (!pick) return null;
  const text = pick.join(" ").trim();
  return text.length < 4 ? null : clipText(text);
}

/**
 * The step a working agent is on: a status line naming it (Codex's header,
 * or Claude's spinner when it shows a checklist step rather than one
 * whimsical word), else the item its checklist marks in progress, else its
 * newest tool call with the first line of what it touched.
 */
function findDoing(rows: readonly string[], request: number): string | null {
  for (let i = rows.length - 1; i > request && i >= rows.length - 6; i--) {
    const spinner = SPINNER.exec(rows[i]!.slice(0, PROBE_CHARS));
    if (!spinner) continue;
    const words = spinner[1]!.replace(/^(?:⏺|•)\s*/, "").trim();
    if (/\s/.test(words) && !/^Working$/i.test(words)) return clipText(words.replace(/…$/, ""));
    break;
  }
  for (let i = rows.length - 1; i > request; i--) {
    const todo = TODO_CURRENT.exec(rows[i]!);
    if (todo) return clipText(todo[1]!);
  }
  const found = blocks(rows, request + 1);
  for (let i = found.length - 1; i >= 0; i--) {
    const block = found[i]!;
    if (block.kind !== "tool") continue;
    const head = rows[block.start]!.replace(BULLET, "$1")
      .replace(/\s*\((?:ctrl|esc)\+?[^)]*\)\s*$/, "")
      .trim();
    if (SPINNER.test(rows[block.start]!.slice(0, PROBE_CHARS))) continue;
    // Only a call still under way is the step it is on; one it finished
    // ("Ran npm test", "Explored") is history, and the agent's own words or
    // the classifier's pick say more.
    if (!IN_PROGRESS.test(head)) return null;
    // "Reading 1 file…" names no file; the row beneath it does. A command's
    // output says nothing about the step.
    const touched = rows[block.start + 1];
    const detail =
      touched !== undefined && BRANCH.test(touched) && /(?:…|\d+ \w+)$/.test(head)
        ? touched.replace(BRANCH, "").trim()
        : "";
    return clipText(detail && detail.length < 80 ? `${head.replace(/…$/, "")}: ${detail}` : head);
  }
  return null;
}

/** The newest tool call on screen, finished or not, as its head row reads. */
function lastToolCall(rows: readonly string[], request: number): string | null {
  const found = blocks(rows, request + 1);
  for (let i = found.length - 1; i >= 0; i--) {
    const block = found[i]!;
    if (block.kind !== "tool" || SPINNER.test(rows[block.start]!.slice(0, PROBE_CHARS))) continue;
    const head = rows[block.start]!.replace(BULLET, "$1")
      .replace(/\s*\((?:ctrl|esc)\+?[^)]*\)\s*$/, "")
      .trim();
    return head.length >= 4 ? clipText(head) : null;
  }
  return null;
}

/**
 * The command line an open approval dialog shows, Codex's `$ cmd` and its
 * kin: a `$` row with the dialog's choices or its confirm hint drawn below it.
 * A `$` line in tool output higher up is not what the dialog asks to run.
 */
function findAction(rows: readonly string[], request: number): string | null {
  // The dialog's choices follow its command with nothing the agent drew in
  // between: a bullet or a branch first means the `$` row was output above it.
  const dialogBelow = (from: number) => {
    for (const row of rows.slice(from + 1, from + 12)) {
      if (DIALOG_CHOICE.test(row) || /^Press enter to confirm\b/i.test(row)) return true;
      if (BULLET.test(row) || BRANCH.test(row)) return false;
    }
    return false;
  };
  for (let i = rows.length - 1; i > request && i >= rows.length - 30; i--) {
    const command = COMMAND.exec(rows[i]!);
    if (command) return dialogBelow(i) ? clipText(command[1]!) : null;
  }
  return null;
}

function clipText(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= GLANCE_CHARS) return flat;
  const cut = flat.slice(0, GLANCE_CHARS);
  const sentence = cut.search(/[.!?](?=\s)[^.!?]*$/);
  if (sentence >= 60) return cut.slice(0, sentence + 1);
  const space = cut.lastIndexOf(" ");
  return `${cut.slice(0, space > 60 ? space : GLANCE_CHARS - 1)}…`;
}
