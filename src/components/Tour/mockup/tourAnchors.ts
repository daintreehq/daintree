export interface CanvasRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Re-measure once a target's own entry transition (200ms) has settled. */
export const ANCHOR_SETTLE_MS = 260;

/** The fixed-size canvas `from` sits in, and how much the stage has scaled it. */
function canvasOf(from: Element) {
  const canvas = from.closest<HTMLElement>("[data-tour-canvas]");
  if (!canvas || canvas.offsetWidth === 0) return null;
  const box = canvas.getBoundingClientRect();
  const scale = box.width / canvas.offsetWidth;
  if (!(scale > 0)) return null;
  return { canvas, box, scale };
}

/** Whether `from` sits in a canvas with real layout (jsdom has none). */
export function hasCanvasLayout(from: Element): boolean {
  return canvasOf(from) !== null;
}

/**
 * Canvas-space rectangle of the `data-tour-anchor` named `name` in the canvas
 * `from` sits in, or null when it isn't rendered. Unpadded and unclamped.
 */
export function measureAnchor(from: Element, name: string): CanvasRect | null {
  const found = canvasOf(from);
  if (!found) return null;
  const { canvas, box, scale } = found;
  // Matched by value rather than a selector, so any name a scene invents is safe.
  const el = [...canvas.querySelectorAll<HTMLElement | SVGElement>("[data-tour-anchor]")].find(
    (candidate) => candidate.dataset.tourAnchor === name
  );
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return null;
  return {
    x: (r.left - box.left) / scale,
    y: (r.top - box.top) / scale,
    width: r.width / scale,
    height: r.height / scale,
  };
}

/** The canvas's own size, for clamping to its edges. */
export function canvasSize(from: Element): { width: number; height: number } | null {
  const found = canvasOf(from);
  return found ? { width: found.canvas.offsetWidth, height: found.canvas.offsetHeight } : null;
}
