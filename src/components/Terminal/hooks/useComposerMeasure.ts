import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { EditorView } from "@codemirror/view";
import { COMPOSER_GEOMETRY_EVENT } from "../inputEditorExtensions";

/**
 * Clear space kept between the end of the draft's last row and the first
 * trailing control when they share that row: the gap the shell puts between
 * its other flex items (`gap-x-1.5`), so the controls sit as far from the text
 * as the `❯` does.
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
function collectPainted(node: Node, rects: DOMRect[], boxes: Set<DOMRect>): void {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      const range = document.createRange();
      range.selectNodeContents(child);
      rects.push(...Array.from(range.getClientRects()));
    } else if (child instanceof Element) {
      if (paintsBox(child)) {
        for (const rect of Array.from(child.getClientRects())) {
          rects.push(rect);
          boxes.add(rect);
        }
      } else {
        collectPainted(child, rects, boxes);
      }
    }
  }
}

interface LastRow {
  /** Right edge of what is painted on the draft's last visual row, client px. */
  right: number;
  /**
   * A painted box on that row spans more than one row: a pill whose label
   * wrapped. It narrows with its measure without gaining a row, which is the
   * one thing that can make a column beside the text shorter than the corner.
   */
  shrinkable: boolean;
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
  const boxes = new Set<DOMRect>();
  collectPainted(line, rects, boxes);
  const drawn = rects.filter((rect) => rect.width >= 0.5 && rect.height >= 0.5);
  if (drawn.length === 0) return { right: line.getBoundingClientRect().left, shrinkable: false };
  const bottom = Math.max(...drawn.map((rect) => rect.bottom));
  const row = drawn.filter((rect) => rect.bottom > bottom - rowPx / 2);
  return {
    right: Math.max(...row.map((rect) => rect.right)),
    shrinkable: row.some((rect) => boxes.has(rect) && rect.height > rowPx * 1.5),
  };
}

/**
 * How many rows the draft's rendered lines take at the current measure.
 *
 * Summed line by line rather than read off `.cm-content`, which CodeMirror
 * gives `min-height: 100%` of the editor: its height would report the rows the
 * editor is sized to now, so a candidate measured in it would inherit the
 * arrangement that is showing.
 */
function rowsOf(content: HTMLElement, rowPx: number): number {
  let rows = 0;
  for (const line of Array.from(content.children)) {
    if (line.classList.contains("cm-line")) {
      rows += Math.round(line.getBoundingClientRect().height / rowPx);
    }
  }
  return rows;
}

interface UseComposerMeasureParams {
  inputShellRef: React.RefObject<HTMLDivElement | null>;
  trailingGroupRef: React.RefObject<HTMLDivElement | null>;
}

/**
 * Places the composer's trailing controls (attach, stash, mic) so the
 * composer spends the least area on them. Its width is the pane's, so its area
 * is its height, and every pixel of that is terminal output the user cannot
 * see.
 *
 * Three arrangements are possible, and all keep the controls in the shell's
 * bottom-right corner:
 *
 * - **Corner** — the text runs the full width and the controls sit beside its
 *   last row. Costs nothing, so it is taken whenever that row ends short of
 *   them.
 * - **Rail** — the controls take a row of their own beneath the text
 *   (`data-composer-rail`, one line of foot). Costs exactly one row.
 * - **Column** — the text gives up the controls' width on every row (an inline
 *   `padding-right` on the canvas track). Costs whatever rows the narrower
 *   measure adds.
 *
 * The corner is taken whenever the last row ends short of the controls.
 * Otherwise the column beats the rail exactly when narrowing the text costs no
 * row — then it shows the same draft in one row less — and the rail is kept on
 * a tie, since full-width text reads better. For text, and for chips that
 * never wrap, that cannot happen while the draft is short enough not to
 * scroll: a narrower measure only moves each greedy line break earlier, so it
 * takes at least one more row whenever the full-width last row runs into the
 * corner. So the column is only laid out and compared for the two shapes where
 * it can win: a pill whose label wrapped, which narrows with the measure and
 * keeps its row count, and a draft at the editor's height cap, where the rail's
 * row is pure cost if the lines are short enough to lose nothing to the column.
 *
 * Every reading is taken in a layout that does not depend on which
 * arrangement is showing — the corner at full width, the column at its fixed
 * narrower width, and the controls at the same x in all three — so the rule
 * cannot feed back on itself: no latch, no hysteresis. The candidate layouts
 * are applied and read synchronously and nothing paints in between.
 *
 * It is also the steadiest placement. The controls never leave the corner, so
 * in a pane whose composer grows upward from the foot they never move. When
 * the last row reaches them they take the row beneath, and when the text then
 * wraps it fills that same row, so the composer grows one line at a time.
 *
 * A draft taller than the editor's cap scrolls, and the row the controls would
 * sit beside is whatever has scrolled to the bottom, so a scrolling editor
 * never takes the corner. Its scroll position is held across the candidate
 * layouts: a wider measure can shorten the draft enough to clamp it.
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
    const track = shell.querySelector<HTMLElement>("[data-composer-canvas]");
    const content = shell.querySelector<HTMLElement>(".cm-content");
    const scroller = shell.querySelector<HTMLElement>(".cm-scroller");
    const scrollTop = scroller?.scrollTop ?? 0;
    const shownColumn = track?.style.paddingRight ?? "";
    // A column from an earlier pass never outlives the pass that chose it, and
    // every reading below is taken at full width.
    if (track && shownColumn) track.style.paddingRight = "";
    let rail = false;
    let column = "";
    if (track && content && scroller && trailing.offsetWidth > 0) {
      const rowPx = parseFloat(getComputedStyle(content).lineHeight) || 20;
      const controlsLeft = trailing.getBoundingClientRect().left;
      // The autosize's own verdict, set only at the height cap. Overflow is not
      // the test: a chip's line box runs a pixel or two past the 20px rhythm
      // the editor's height snaps to, so a two-row draft holding one
      // overflows by 2px without scrolling anything.
      const scrolls = scroller.style.overflowY === "auto";
      const end = scrolls ? null : lastRow(content, rowPx);
      rail = end === null || end.right + CORNER_GAP_PX > controlsLeft;
      if (rail && (scrolls || end?.shrinkable)) {
        const fullRows = rowsOf(content, rowPx);
        // Wide enough that the text's right edge, the editor's own inset
        // included, stops a corner gap short of the controls.
        const inset = parseFloat(getComputedStyle(content).paddingRight) || 0;
        const width = track.getBoundingClientRect().right - controlsLeft + CORNER_GAP_PX - inset;
        track.style.paddingRight = `${Math.ceil(width)}px`;
        if (rowsOf(content, rowPx) <= fullRows) {
          column = track.style.paddingRight;
          rail = false;
        }
      }
      if (track.style.paddingRight !== column) track.style.paddingRight = column;
    }
    if (scroller && scroller.scrollTop !== scrollTop) scroller.scrollTop = scrollTop;
    // A column taken or given up re-wraps the draft. Left to its own
    // ResizeObserver, CodeMirror re-measures the lines a frame or more later
    // and the autosize resizes a cycle after that, so the shell sat at a stale
    // height for up to six frames of a pane drag. Asked now, the re-measure
    // joins the pass in flight, or the very next one.
    if (column !== shownColumn && content) EditorView.findFromDOM(content)?.requestMeasure();

    if (rail === shell.hasAttribute("data-composer-rail")) return;
    shell.toggleAttribute("data-composer-rail", rail);
  }, [inputShellRef, trailingGroupRef]);

  // Measured inside the observer's callback, not deferred to a frame: it runs
  // after layout and before paint, so a pane dragged past a decision point
  // never paints a frame of the old arrangement with the controls over the
  // text it just re-wrapped. Both are observed at their border boxes, which
  // nothing `measure` writes can change in the same frame — the rail is the
  // shell's padding, the column the track's own — so the callback cannot
  // re-trigger itself.
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
