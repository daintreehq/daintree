import type { ChangeData, HunkData } from "react-diff-view";

export type DiffNoteSide = "old" | "new";

/**
 * Where a note points. A change key (`I12`) is only a line number, and a
 * refreshed diff renumbers every line below an upstream edit, so a line anchor
 * also carries a hash of the text it was written against. The hash is what
 * lets a moved diff mark the note stale instead of pinning it to whatever line
 * now sits at that number.
 */
export type DiffNoteAnchor =
  | { kind: "file" }
  | {
      kind: "lines";
      side: DiffNoteSide;
      startLine: number;
      endLine: number;
      contentHash: string;
    };

export interface DiffNote {
  id: string;
  worktreePath: string;
  /** Worktree-relative path, as the diff names it. */
  filePath: string;
  anchor: DiffNoteAnchor;
  body: string;
  createdAt: number;
  updatedAt: number;
}

export interface DiffLineInfo {
  key: string;
  content: string;
}

/** Line number → rendered row, per side, over whatever hunks are on screen. */
export interface DiffLineIndex {
  old: Map<number, DiffLineInfo>;
  new: Map<number, DiffLineInfo>;
}

/**
 * react-diff-view's `getChangeKey`, restated so the send path (which formats
 * notes but never renders a diff) doesn't pull the library into its chunk.
 */
function changeKey(change: ChangeData): string {
  if (change.type === "insert") return `I${change.lineNumber}`;
  if (change.type === "delete") return `D${change.lineNumber}`;
  return `N${change.oldLineNumber}`;
}

export function buildDiffLineIndex(hunks: readonly HunkData[]): DiffLineIndex {
  const index: DiffLineIndex = { old: new Map(), new: new Map() };
  for (const hunk of hunks) {
    for (const change of hunk.changes) {
      const info = { key: changeKey(change), content: change.content };
      if (change.type === "insert") {
        if (change.lineNumber !== undefined) index.new.set(change.lineNumber, info);
      } else if (change.type === "delete") {
        if (change.lineNumber !== undefined) index.old.set(change.lineNumber, info);
      } else {
        if (change.oldLineNumber !== undefined) index.old.set(change.oldLineNumber, info);
        if (change.newLineNumber !== undefined) index.new.set(change.newLineNumber, info);
      }
    }
  }
  return index;
}

/**
 * The side and line a gutter click notes. A changed line belongs to the side
 * that owns it; a context line is read on the new side, which is the file the
 * agent has on disk — and unified rows don't report a side for it anyway.
 */
export function lineForChange(change: ChangeData): { side: DiffNoteSide; line: number } | null {
  if (change.type === "delete") {
    return change.lineNumber === undefined ? null : { side: "old", line: change.lineNumber };
  }
  const line = change.type === "insert" ? change.lineNumber : change.newLineNumber;
  return line === undefined ? null : { side: "new", line };
}

// FNV-1a: stable, cheap, and collision resistance only has to beat "the line
// at this number now says something else".
function hashText(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Hash of the lines a range covers, or null when any of them is not on screen.
 * Lengths are folded in so a range can't match by shifting text across a line
 * boundary.
 */
export function hashLineRange(
  index: DiffLineIndex,
  side: DiffNoteSide,
  startLine: number,
  endLine: number
): string | null {
  const lines = side === "old" ? index.old : index.new;
  let joined = "";
  for (let line = startLine; line <= endLine; line++) {
    const info = lines.get(line);
    if (!info) return null;
    joined += `${info.content.length}:${info.content}\n`;
  }
  return hashText(joined);
}

export type DiffNotePlacement =
  | { status: "file" }
  | { status: "anchored"; widgetKey: string; selectedKeys: string[] }
  | { status: "stale" }
  | { status: "unplaced" };

/**
 * A line note is anchored only when every line it covers is rendered and still
 * reads as it did when the note was written. When the rows are there but the
 * text differs, the diff moved under it: stale. When the rows aren't rendered
 * at all (collapsed context, a narrowed diff) nothing proves either way, so it
 * is unplaced rather than stale. Neither is ever re-attached to whatever now
 * sits at those numbers.
 */
export function placeDiffNote(note: DiffNote, index: DiffLineIndex): DiffNotePlacement {
  const { anchor } = note;
  if (anchor.kind === "file") return { status: "file" };
  const hash = hashLineRange(index, anchor.side, anchor.startLine, anchor.endLine);
  if (hash === null) return { status: "unplaced" };
  if (hash !== anchor.contentHash) return { status: "stale" };
  const lines = anchor.side === "old" ? index.old : index.new;
  const selectedKeys: string[] = [];
  for (let line = anchor.startLine; line <= anchor.endLine; line++) {
    const info = lines.get(line);
    if (info) selectedKeys.push(info.key);
  }
  const last = selectedKeys[selectedKeys.length - 1];
  if (last === undefined) return { status: "unplaced" };
  return { status: "anchored", widgetKey: last, selectedKeys };
}

export function formatDiffNoteLines(anchor: DiffNoteAnchor): string {
  if (anchor.kind === "file") return "whole file";
  const range =
    anchor.startLine === anchor.endLine
      ? String(anchor.startLine)
      : `${anchor.startLine}-${anchor.endLine}`;
  // Old-side numbers point into the pre-change file; without the tag an agent
  // would read them against the file on disk.
  return anchor.side === "old" ? `${range} (removed lines)` : range;
}

// Backslashes first, so the escape added for a quote or line break isn't
// itself doubled. Line breaks are escaped so each note stays three lines.
function quoteNoteBody(body: string): string {
  const escaped = body
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r\n|\r|\n/g, "\\n");
  return `"${escaped}"`;
}

/**
 * Three lines per note — `File:`, `Line(s):`, the quoted comment — with a blank
 * line between notes and no preamble, so the reviewer's own words lead the
 * agent's next turn.
 */
export function formatDiffNotesPrompt(
  notes: readonly DiffNote[],
  resolvePath: (note: DiffNote) => string = (note) => note.filePath
): string {
  return notes
    .map(
      (note) =>
        `File: ${resolvePath(note)}\nLine(s): ${formatDiffNoteLines(note.anchor)}\n${quoteNoteBody(note.body.trim())}`
    )
    .join("\n\n");
}

function anchorOrder(anchor: DiffNoteAnchor): number {
  return anchor.kind === "file" ? 0 : anchor.startLine;
}

/** File order, then file notes before line notes, then by line. */
export function sortDiffNotes(notes: readonly DiffNote[]): DiffNote[] {
  return [...notes].sort((a, b) => {
    if (a.filePath !== b.filePath) return a.filePath < b.filePath ? -1 : 1;
    const byLine = anchorOrder(a.anchor) - anchorOrder(b.anchor);
    if (byLine !== 0) return byLine;
    return a.createdAt - b.createdAt;
  });
}
