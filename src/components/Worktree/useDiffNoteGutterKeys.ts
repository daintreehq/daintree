import { useLayoutEffect, useRef } from "react";
import type { FocusEvent, KeyboardEvent, RefObject } from "react";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { describeAnchor } from "./DiffNoteWidgets";
import {
  hashLineRange,
  type DiffLineIndex,
  type DiffNoteLines,
  type DiffNoteSide,
} from "./diffNotes";

const TARGET_SELECTOR = "[data-note-line]";

/** A keyboard selection of lines: `anchor` stays put while `head` follows the focus. */
export interface DiffNoteLineSelection {
  side: DiffNoteSide;
  anchor: number;
  head: number;
}

export function selectionLines(selection: DiffNoteLineSelection): DiffNoteLines {
  return {
    kind: "lines",
    side: selection.side,
    startLine: Math.min(selection.anchor, selection.head),
    endLine: Math.max(selection.anchor, selection.head),
  };
}

function isTarget(node: EventTarget | null): node is HTMLElement {
  return node instanceof HTMLElement && node.matches(TARGET_SELECTOR);
}

function readSide(element: HTMLElement): DiffNoteSide {
  return element.dataset.noteSide === "old" ? "old" : "new";
}

function readLine(element: HTMLElement): number {
  return Number(element.dataset.noteLine);
}

/**
 * The next line number in reading order, optionally on one side only. Read from
 * the live table on each press, so rows a staged mount added since the last one
 * are simply there, and only rows that have mounted can be reached.
 */
function neighbour(
  root: HTMLElement,
  from: HTMLElement,
  step: 1 | -1,
  side?: DiffNoteSide
): HTMLElement | null {
  const targets = root.querySelectorAll<HTMLElement>(TARGET_SELECTOR);
  const at = Array.prototype.indexOf.call(targets, from);
  if (at === -1) return null;
  for (let i = at + step; i >= 0 && i < targets.length; i += step) {
    const candidate = targets[i];
    if (candidate && (!side || readSide(candidate) === side)) return candidate;
  }
  return null;
}

/**
 * The closest line number in the other split column. Not simply the same row: a
 * lone deletion has nothing beside it, and a context row's number lives only in
 * the new column, so the nearest one in reading order stands in, with ties going
 * the way the key points.
 */
function acrossColumns(root: HTMLElement, from: HTMLElement, step: 1 | -1): HTMLElement | null {
  const other = readSide(from) === "old" ? "new" : "old";
  const targets = root.querySelectorAll<HTMLElement>(TARGET_SELECTOR);
  const at = Array.prototype.indexOf.call(targets, from);
  if (at === -1) return null;
  for (let distance = 1; distance < targets.length; distance++) {
    for (const index of [at + step * distance, at - step * distance]) {
      const candidate = targets[index];
      if (candidate && readSide(candidate) === other) return candidate;
    }
  }
  return null;
}

interface DiffNoteGutterKeysOptions {
  /** Holds the table. The handlers below go on this same element. */
  rootRef: RefObject<HTMLElement | null>;
  /** The keys hint, shown while a line number has keyboard focus. */
  hintRef: RefObject<HTMLElement | null>;
  enabled: boolean;
  /** Split columns: Up and Down keep to a column, Left and Right cross it. */
  columns: boolean;
  lineIndex: DiffLineIndex | null;
  selection: DiffNoteLineSelection | null;
  setSelection: (selection: DiffNoteLineSelection | null) => void;
  /** The gutter click's own path, so Enter and a click can never disagree. */
  onStartDraft: (target: { side: DiffNoteSide; line: number }, extend: boolean) => void;
  onOpenLines: (lines: DiffNoteLines) => void;
}

/**
 * Keyboard reach for line notes. The line numbers share one tab stop per file
 * and the arrow keys rove it, because a stop on every line would make Tab useless
 * in a diff of any length.
 *
 * Roving is written straight to the DOM, as in useToolbarRoving, and for a sharper
 * reason here: routing it through props would re-render every row of a table that
 * can run to tens of thousands on each arrow press. React renders every number at
 * -1 and never writes the attribute again, since the prop doesn't change.
 */
export function useDiffNoteGutterKeys({
  rootRef,
  hintRef,
  enabled,
  columns,
  lineIndex,
  selection,
  setSelection,
  onStartDraft,
  onOpenLines,
}: DiffNoteGutterKeysOptions) {
  const stopRef = useRef<HTMLElement | null>(null);

  // Every commit, not on a dependency: the stop's row can go with a staged
  // batch, a refresh, a layout switch or a collapse, and checking it is a pointer
  // read until one of those takes it. tabIndex is read as well as isConnected, as
  // switching notes off and on again keeps the node but wipes its attribute.
  useLayoutEffect(() => {
    if (!enabled) return;
    const stop = stopRef.current;
    if (stop?.isConnected && stop.tabIndex === 0) return;
    const first = rootRef.current?.querySelector<HTMLElement>(TARGET_SELECTOR) ?? null;
    if (first) first.tabIndex = 0;
    stopRef.current = first;
  });

  const extendSelection = (from: HTMLElement, step: 1 | -1) => {
    const root = rootRef.current;
    if (!root) return;
    const side = selection?.side ?? readSide(from);
    const anchor = selection?.anchor ?? readLine(from);
    const next = neighbour(root, from, step, side);
    if (!next) return;
    const extended: DiffNoteLineSelection = { side, anchor, head: readLine(next) };
    const lines = selectionLines(extended);
    // A note covers one unbroken run. Past a gap the keys stop, rather than
    // quietly selecting lines nobody can see.
    if (!lineIndex || hashLineRange(lineIndex, side, lines.startLine, lines.endLine) === null) {
      useAnnouncerStore.getState().announce("Hidden lines stop this selection");
      return;
    }
    setSelection(extended);
    useAnnouncerStore.getState().announce(`${describeAnchor(lines)} selected`);
    next.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const element = event.target;
    if (!isTarget(element)) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const root = rootRef.current;
    if (!root) return;
    switch (event.key) {
      case "Enter":
      case " ":
        event.preventDefault();
        // Held Shift from the selecting is still down on most presses here, so
        // a selection outranks Shift+Enter's extend.
        if (selection) {
          setSelection(null);
          onOpenLines(selectionLines(selection));
        } else {
          onStartDraft({ side: readSide(element), line: readLine(element) }, event.shiftKey);
        }
        return;
      case "ArrowUp":
      case "ArrowDown": {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        if (event.shiftKey) {
          extendSelection(element, step);
          return;
        }
        const next = neighbour(root, element, step, columns ? readSide(element) : undefined);
        if (!next) return;
        setSelection(null);
        next.focus();
        return;
      }
      case "ArrowLeft":
      case "ArrowRight": {
        if (!columns || event.shiftKey) return;
        const next = acrossColumns(root, element, event.key === "ArrowRight" ? 1 : -1);
        if (!next) return;
        event.preventDefault();
        setSelection(null);
        next.focus();
        return;
      }
      case "Escape":
        // With nothing selected this Escape belongs to whatever hosts the diff.
        if (!selection) return;
        event.preventDefault();
        event.stopPropagation();
        setSelection(null);
        return;
    }
  };

  const onFocus = (event: FocusEvent<HTMLElement>) => {
    const element = event.target;
    if (!isTarget(element)) return;
    if (stopRef.current !== element) {
      if (stopRef.current) stopRef.current.tabIndex = -1;
      element.tabIndex = 0;
      stopRef.current = element;
    }
    // Keys are for someone using them: a click on a number focuses it too.
    if (element.matches(":focus-visible")) hintRef.current?.setAttribute("data-active", "");
  };

  const onBlur = (event: FocusEvent<HTMLElement>) => {
    if (!isTarget(event.target) || isTarget(event.relatedTarget)) return;
    hintRef.current?.removeAttribute("data-active");
    setSelection(null);
  };

  return { onKeyDown, onFocus, onBlur };
}
