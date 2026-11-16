import { useLayoutEffect, useState } from "react";

/** Space kept between the maximized readout and anything it might meet. */
const READOUT_CLEARANCE_PX = 12;

interface FrameMeasure {
  /** Ask for a measurement; every request before the next frame shares one. */
  schedule: () => void;
  /** Measure now, dropping any frame already requested. */
  flush: () => void;
  dispose: () => void;
}

/**
 * Coalesces a header's layout reads into one per frame, and none while the
 * element renders nothing. Live readings tick their text many times a frame
 * across every pane, so measuring per mutation forced a layout each time. A
 * pane parked by the dock sits under `content-visibility: hidden`
 * (DockPanelOffscreenContainer), where a read forces layout of a subtree the
 * engine is otherwise skipping; `checkVisibility()` answers that from style
 * alone. While hidden, an IntersectionObserver waits for the element to render
 * again so the reveal is measured even when nothing else changes.
 */
function createFrameMeasure(el: HTMLElement, measure: () => void): FrameMeasure {
  let frame: number | null = null;
  let reveal: IntersectionObserver | null = null;
  let disposed = false;

  const renders = () => typeof el.checkVisibility !== "function" || el.checkVisibility();

  const run = () => {
    if (disposed || !el.isConnected) return;
    if (!renders()) {
      if (reveal === null && typeof IntersectionObserver !== "undefined") {
        reveal = new IntersectionObserver(schedule);
        reveal.observe(el);
      }
      return;
    }
    reveal?.disconnect();
    reveal = null;
    measure();
  };

  function schedule() {
    if (disposed || frame !== null) return;
    let ran = false;
    const id = requestAnimationFrame(() => {
      ran = true;
      frame = null;
      run();
    });
    // A synchronous stand-in (tests) has already run it; keeping its id would
    // read as a frame still pending and swallow every later request.
    if (!ran) frame = id;
  }

  const cancelFrame = () => {
    if (frame === null) return;
    cancelAnimationFrame(frame);
    frame = null;
  };

  return {
    schedule,
    flush: () => {
      cancelFrame();
      run();
    },
    dispose: () => {
      disposed = true;
      cancelFrame();
      reveal?.disconnect();
      reveal = null;
    },
  };
}

/**
 * Whether the maximized readout, centred over the whole bar, clears everything
 * the bar lays out around it: the identity group, the metadata, the tab strip,
 * a plugin toolbar, the status box and the controls, each marked
 * `data-readout-obstacle`. The readout is absolute, so hiding it never moves
 * what it is measured against. The status box counts even when empty: it is
 * reserved space a status can appear in.
 */
export function useReadoutClearance(readout: HTMLElement | null, active: boolean): boolean {
  const [clear, setClear] = useState(true);
  useLayoutEffect(() => {
    const bar = readout?.parentElement;
    if (!active || !readout || !bar || typeof ResizeObserver === "undefined") {
      setClear(true);
      return;
    }
    let targetsStale = true;
    const measure = () => {
      // Obstacles come and go (a chip, a tab strip), so the set is re-observed
      // after the bar's tree changes rather than once at mount.
      if (targetsStale) {
        targetsStale = false;
        resizes.disconnect();
        resizes.observe(bar);
        resizes.observe(readout);
        bar.querySelectorAll("[data-readout-obstacle]").forEach((el) => resizes.observe(el));
      }
      const r = readout.getBoundingClientRect();
      const blocked = Array.from(bar.querySelectorAll<HTMLElement>("[data-readout-obstacle]")).some(
        (el) => {
          const o = el.getBoundingClientRect();
          return (
            o.width > 0 &&
            o.right + READOUT_CLEARANCE_PX > r.left &&
            o.left - READOUT_CLEARANCE_PX < r.right
          );
        }
      );
      setClear(!blocked);
    };
    const frame = createFrameMeasure(readout, measure);
    const resizes = new ResizeObserver(frame.schedule);
    const mutations = new MutationObserver(() => {
      targetsStale = true;
      frame.schedule();
    });
    mutations.observe(bar, { childList: true, subtree: true });
    // Settled before the first paint, so the readout never flashes over the
    // title it is about to stand aside for.
    frame.flush();
    return () => {
      frame.dispose();
      mutations.disconnect();
      resizes.disconnect();
    };
  }, [active, readout]);
  return clear;
}

/**
 * Priority+ for the metadata row: whatever cannot fit leaves whole rather than
 * being clipped mid-number by the row's edge. Items leave in attention order,
 * not position: lowest `data-fit-priority` first (unmarked items, the ambient
 * readings, count as 0), and among equals the later one first, so a waiting
 * decision outlasts a queue count and the telemetry goes before either. Items
 * are hidden with the `hidden` attribute, which takes them out of the tab order
 * too, and all are tried again whenever the bar, the row or the status beside
 * it changes, so a widening bar or a status clearing brings them back.
 */
export function useWholeItemFit(row: HTMLElement | null): void {
  useLayoutEffect(() => {
    const region = row?.parentElement?.parentElement;
    if (!row || !region || typeof ResizeObserver === "undefined") return;
    const overflows = () => row.scrollWidth > row.clientWidth + 0.5;
    const fit = () => {
      const items = Array.from(row.children).filter(
        (child): child is HTMLElement => child instanceof HTMLElement
      );
      for (const item of items) item.removeAttribute("hidden");
      if (!overflows()) return;
      const leaving = items
        .map((item, index) => ({ item, index, priority: Number(item.dataset.fitPriority ?? 0) }))
        .sort((a, b) => a.priority - b.priority || b.index - a.index);
      for (const { item } of leaving) {
        if (!overflows()) break;
        // Never pulled out from under the keyboard: a reading or chip being
        // read stays until focus leaves it, and the clip covers the rest.
        if (item.contains(document.activeElement)) continue;
        item.setAttribute("hidden", "");
      }
    };
    const frame = createFrameMeasure(row, fit);
    const resizes = new ResizeObserver(frame.schedule);
    // The row's room depends on its siblings too: a title renamed shorter or a
    // mark leaving the identity group frees width without the bar resizing.
    const observeAll = () => {
      resizes.disconnect();
      resizes.observe(region);
      resizes.observe(row);
      for (const child of Array.from(region.children)) resizes.observe(child);
    };
    observeAll();
    const regionChildren = new MutationObserver(observeAll);
    regionChildren.observe(region, { childList: true });
    // Chips arrive and leave with the pane's state, text inside them changes,
    // and the status beside the row takes and gives back room. The `hidden`
    // the fit itself sets is an attribute, which is not observed.
    // A chip whose priority rises (a subagent now waiting) is re-weighed too.
    const mutations = new MutationObserver(frame.schedule);
    mutations.observe(row.parentElement!, {
      childList: true,
      subtree: true,
      characterData: true,
      attributeFilter: ["data-fit-priority"],
    });
    // An item kept because it held focus is weighed again once focus leaves.
    const onFocusOut = (event: FocusEvent) => {
      const next = event.relatedTarget;
      if (!(next instanceof Node) || !row.contains(next)) frame.schedule();
    };
    row.addEventListener("focusout", onFocusOut);
    frame.flush();
    return () => {
      frame.dispose();
      resizes.disconnect();
      mutations.disconnect();
      regionChildren.disconnect();
      row.removeEventListener("focusout", onFocusOut);
    };
  }, [row]);
}
