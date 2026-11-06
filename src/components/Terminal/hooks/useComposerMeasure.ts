import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { EditorView } from "@codemirror/view";
import { COMPOSER_DRAFT_RESET_ATTR, COMPOSER_GEOMETRY_EVENT } from "../inputEditorExtensions";

/**
 * Clear space kept between the end of the draft's last row and the first
 * trailing control when they share that row: the space between the `❯` and
 * the text (the shell's `gap-x-0.75` plus the editor's 3px left padding), so
 * the controls sit as far from the text as the `❯` does.
 */
const CORNER_GAP_PX = 6;

/** Whether an element paints a box of its own, rather than only its text. */
function paintsBox(el: Element): boolean {
  if (el instanceof HTMLImageElement || el instanceof SVGElement) return true;
  const style = getComputedStyle(el);
  return (
    (style.backgroundColor !== "rgba(0, 0, 0, 0)" && style.backgroundColor !== "transparent") ||
    style.backgroundImage !== "none" ||
    (style.borderTopStyle !== "none" && parseFloat(style.borderTopWidth) > 0)
  );
}

/**
 * What is actually drawn under `node`: each run of text, and the whole box of
 * anything that paints one (a pill chip's tint, a thumbnail). An element that
 * paints nothing is looked through to its text, so the empty right of a
 * wrapped `@file` chip, which is transparent, counts as empty — while a
 * wrapped pill is measured whole, never tucked into.
 */
function collectPainted(node: Node, rects: DOMRect[]): void {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      const range = document.createRange();
      range.selectNodeContents(child);
      rects.push(...Array.from(range.getClientRects()));
    } else if (child instanceof Element) {
      if (paintsBox(child)) {
        rects.push(...Array.from(child.getClientRects()));
      } else {
        collectPainted(child, rects);
      }
    }
  }
}

interface LastRow {
  /** Right edge of what is painted on the draft's last visual row, client px. */
  right: number;
}

/**
 * The draft's last visual row, or `null` when the end of the draft is not laid
 * out where it can be measured.
 *
 * Read from the DOM rather than `coordsAtPos`: the end of the document is not
 * always the end of what is drawn. Interim dictation is a widget after it, an
 * empty draft draws its placeholder, and both take the row's width as text
 * does.
 */
function lastRow(content: HTMLElement, rowPx: number): LastRow | null {
  const line = content.lastElementChild;
  // A gap or block widget after the last line means the end of the draft is
  // outside CodeMirror's rendered viewport.
  if (!(line instanceof HTMLElement) || !line.classList.contains("cm-line")) return null;
  const rects: DOMRect[] = [];
  collectPainted(line, rects);
  const drawn = rects.filter((rect) => rect.width >= 0.5 && rect.height >= 0.5);
  if (drawn.length === 0) return { right: line.getBoundingClientRect().left };
  const bottom = Math.max(...drawn.map((rect) => rect.bottom));
  const row = drawn.filter((rect) => rect.bottom > bottom - rowPx / 2);
  return { right: Math.max(...row.map((rect) => rect.right)) };
}

interface UseComposerMeasureParams {
  inputShellRef: React.RefObject<HTMLDivElement | null>;
  trailingGroupRef: React.RefObject<HTMLDivElement | null>;
}

/**
 * Places the composer's trailing controls (attach, stash, mic) in one of two
 * arrangements, both keeping them in the shell's bottom-right corner:
 *
 * - **Corner** — the text runs the full width and the controls sit beside its
 *   last row. Costs nothing, so a short draft takes it.
 * - **Rail** — the controls take a row of their own beneath the text
 *   (`data-composer-rail`, one line of foot). Costs exactly one row, and the
 *   text keeps the full width above it.
 *
 * The corner is left for the rail once the last row reaches the controls, or
 * the draft scrolls at the editor's height cap, and the rail then latches: the
 * attribute itself is the latch, and only a new draft releases it: one emptied
 * (sent or cleared) or replaced whole, as the autosize reports it
 * (`COMPOSER_DRAFT_RESET_ATTR`) even when no pass saw it empty. Deleting text,
 * or a pane widening, never moves the controls back, so a draft being typed, pasted or dictated changes its text width at
 * most once instead of rewrapping as one word tips a per-pass rule either way.
 * The text never narrows to make room for the controls, so nothing here
 * rewraps a draft after the one move into the rail.
 *
 * A draft taller than the editor's cap scrolls, and the row the controls would
 * sit beside is whatever has scrolled to the bottom, so a scrolling editor
 * never takes the corner.
 *
 * Measured on every editor layout pass (`COMPOSER_GEOMETRY_EVENT`, sent from
 * the autosize measure, so in the same frame as the text it describes) and
 * whenever the canvas track or the control group changes size — a pane being
 * resized, or a stash button arriving, which widens the group without the
 * editor noticing.
 *
 * Returns the ref for the canvas track (`[data-composer-canvas]`). It is a
 * callback ref because the track sits under a Radix trigger that can remount
 * it when its lazy chunk resolves, and the observer has to follow.
 */
export function useComposerMeasure({
  inputShellRef,
  trailingGroupRef,
}: UseComposerMeasureParams): (node: HTMLDivElement | null) => void {
  const [shellEl, setShellEl] = useState<HTMLDivElement | null>(null);
  const [trailingEl, setTrailingEl] = useState<HTMLDivElement | null>(null);
  const [trackEl, setTrackEl] = useState<HTMLDivElement | null>(null);

  // Both elements are rendered on the first commit, so a single read after
  // layout is enough to start observing them; the RAF pass is a guard against
  // a ref that attaches a frame late. Same pattern as
  // `useAutocompletePositioning`.
  useLayoutEffect(() => {
    let cancelled = false;
    let rafId: number | null = null;

    const sync = () => {
      if (cancelled) return;
      const nextShell = inputShellRef.current;
      const nextTrailing = trailingGroupRef.current;
      setShellEl((current) => (current === nextShell ? current : nextShell));
      setTrailingEl((current) => (current === nextTrailing ? current : nextTrailing));
    };

    sync();
    rafId = requestAnimationFrame(sync);

    return () => {
      cancelled = true;
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [inputShellRef, trailingGroupRef]);

  const measure = useCallback(() => {
    const shell = inputShellRef.current;
    const trailing = trailingGroupRef.current;
    if (!shell || !trailing) return;

    // Read through the shell, not the view: the editor moves to the Expanded
    // Editor and back, and only one that is in this shell sits beside these
    // controls. With none here the canvas is empty and the corner is free,
    // and a group with no buttons in it (another host's terminal, seen from
    // Canopy) has no corner to claim.
    const content = shell.querySelector<HTMLElement>(".cm-content");
    const scroller = shell.querySelector<HTMLElement>(".cm-scroller");
    const editor = shell.querySelector<HTMLElement>(".cm-editor");
    // A draft emptied or replaced whole since the last pass is a new draft,
    // even if this pass is the first to see it and it already holds text.
    const draftReset = editor?.hasAttribute(COMPOSER_DRAFT_RESET_ATTR) ?? false;
    if (draftReset) editor?.removeAttribute(COMPOSER_DRAFT_RESET_ATTR);
    let rail = false;
    if (content && scroller && trailing.offsetWidth > 0) {
      const rowPx = parseFloat(getComputedStyle(content).lineHeight) || 20;
      // The autosize's own verdict, set only at the height cap. Overflow is not
      // the test: a chip's line box runs a pixel or two past the 20px rhythm
      // the editor's height snaps to, so a two-row draft holding one
      // overflows by 2px without scrolling anything.
      const scrolls = scroller.style.overflowY === "auto";
      const empty = EditorView.findFromDOM(content)?.state.doc.length === 0;
      if (!empty && !draftReset && shell.hasAttribute("data-composer-rail")) {
        rail = true;
      } else {
        const end = scrolls ? null : lastRow(content, rowPx);
        rail = end === null || end.right + CORNER_GAP_PX > trailing.getBoundingClientRect().left;
      }
    }

    if (rail === shell.hasAttribute("data-composer-rail")) return;
    shell.toggleAttribute("data-composer-rail", rail);
  }, [inputShellRef, trailingGroupRef]);

  // Measured inside the observer's callback, not deferred to a frame: it runs
  // after layout and before paint, so a pane dragged past a decision point
  // never paints a frame of the old arrangement with the controls over the
  // text it just re-wrapped. Both are observed at their border boxes, which
  // nothing `measure` writes can change in the same frame — the rail is the
  // shell's padding — so the callback cannot re-trigger itself.
  //
  // A resize also asks CodeMirror to re-measure now. Its own resize handling
  // waits out a 50ms debounce before it measures the re-wrapped lines, so the
  // autosize — and the shell with it — sat at the old row count for three to
  // six frames of every drag that changed it.
  useLayoutEffect(() => {
    if (!trackEl || !trailingEl) return;
    const observer = new ResizeObserver(() => {
      measure();
      const content = trackEl.querySelector<HTMLElement>(".cm-content");
      if (content) EditorView.findFromDOM(content)?.requestMeasure();
    });
    observer.observe(trackEl, { box: "border-box" });
    observer.observe(trailingEl, { box: "border-box" });
    return () => observer.disconnect();
  }, [trackEl, trailingEl, measure]);

  useEffect(() => {
    if (!shellEl) return;
    shellEl.addEventListener(COMPOSER_GEOMETRY_EVENT, measure);
    return () => shellEl.removeEventListener(COMPOSER_GEOMETRY_EVENT, measure);
  }, [shellEl, measure]);

  useLayoutEffect(() => {
    measure();
  }, [measure, shellEl, trailingEl, trackEl]);

  return setTrackEl;
}
