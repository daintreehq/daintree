import { useEffect, useRef, useState } from "react";
import { useShouldSkipMotion } from "@/hooks/useShouldSkipMotion";
import { PANEL_RESTORE_DURATION } from "@/lib/animationUtils";
import {
  SPLASH_COLOR_FULL,
  SPLASH_COLOR_PARTIAL,
  SPLASH_FPS,
  SPLASH_FRAMES,
  SPLASH_LINGER_MS,
  type SplashRow,
} from "./splashFrames";

/**
 * The Daintree boot mark, drawing itself in while the engine starts.
 *
 * ## Why it lives here and not in the engine
 *
 * The CLI played this itself, straight to the terminal, before Bubble Tea started. The
 * engine is now headless and has no screen — so the animation belongs to Daintree. It
 * is the same mark on the same timeline (40 frames at 80fps, then a 240ms linger), from
 * the same source frames, so an embedded session boots looking like the CLI booted.
 *
 * ## Why it is a block grid rather than a re-animated SVG
 *
 * Because the original is. The mark is a vector clipped by animated mask strokes and
 * then supersampled onto a terminal grid — the blockiness is the look, not a limitation
 * being worked around. Re-animating the SVG directly would be smoother and would not be
 * the same thing.
 *
 * The blocks are DRAWN as rectangles rather than printed as block glyphs. A glyph's
 * width is whatever the font says it is, and the block characters here are outside the
 * subset we ship, so they came from whichever fallback the OS picked: the grid's shape
 * was hostage to a font we do not control. Rectangles put the block's width and height
 * under our control, which is what makes the proportions below expressible at all.
 *
 * The splash overlaps real work: MCP connect, backend handshake and project resolution
 * all run inside the ~740ms it plays. It does not wait for them and they do not wait for
 * it — `done` fires on its own timeline, and the panel is interactive underneath the
 * whole time, exactly as the cockpit's composer was live while its splash played.
 */

export interface AssistantBootSplashProps {
  /** Called once the reveal and its linger have finished. */
  onDone?: () => void;
  className?: string;
}

const FRAME_MS = 1000 / SPLASH_FPS;

/**
 * Block size, in the brand mark's own coordinate units.
 *
 * The CLI sampled the mark's bounding box — 622.393 × 473.394 units of the source
 * artwork — across 44 grid columns and 14 grid rows (`splash_vector.go`:
 * `x = leftEdge + (col - 3)/scaleX`, `y = topY + row/scaleY`). So one block spans
 * exactly that much artwork, and a block is ~0.42 as wide as it is tall.
 *
 * That ratio is the whole point of drawing rectangles: printed as monospace glyphs the
 * blocks were as wide as a character cell — 0.6 — which stretched the mark about 43%
 * wider than the logo actually is. Blocks this shape reproduce the mark's real
 * proportions at any size.
 */
const MARK_WIDTH = 622.393;
const MARK_HEIGHT = 473.394;
const MARK_COLUMNS = 44;
const MARK_ROWS = 14;
/** Grid column the mark's left edge starts at; columns 0-2 are terminal padding. */
const MARK_COLUMN_OFFSET = 3;
const BLOCK_WIDTH = MARK_WIDTH / MARK_COLUMNS;
const BLOCK_HEIGHT = MARK_HEIGHT / MARK_ROWS;

/**
 * How wide the mark is allowed to draw. Below this it fills the panel: the sidebar's
 * 380px default leaves it ~308px once the list and splash padding are taken out, so the
 * cap only starts biting just above that. Past it the mark stops growing, because one
 * scaled to an 800px sidebar would be a logo occupying the surface rather than a boot
 * state occupying part of it.
 */
const MAX_MARK_WIDTH = 320;

/**
 * How long the reveal waits before its first frame.
 *
 * Opening the assistant slides the sidebar in over `PANEL_RESTORE_DURATION`, and a mark
 * drawing itself inside a panel that is still arriving reads as two animations talking
 * over each other. This lands just inside that slide rather than after it: the slide is
 * on ease-out-expo, so it is visually settled well before it formally ends, and starting
 * a beat early means the draw picks up where the panel left off instead of pausing.
 */
const REVEAL_DELAY = Math.round(PANEL_RESTORE_DURATION * 0.8);

/** Quadrant bits, in the order a glyph's four sub-cells are addressed below. */
const TOP_LEFT = 1;
const TOP_RIGHT = 2;
const BOTTOM_LEFT = 4;
const BOTTOM_RIGHT = 8;

/**
 * The frames use the quadrant block characters, each of which is a 2×2 sub-grid of the
 * cell: the supersampler resolved every cell to quarter coverage, so the mark is really
 * a 96×36 grid wearing a 48×18 one.
 */
const GLYPH_QUADRANTS: Record<string, number> = {
  " ": 0,
  "█": TOP_LEFT | TOP_RIGHT | BOTTOM_LEFT | BOTTOM_RIGHT,
  "▀": TOP_LEFT | TOP_RIGHT,
  "▄": BOTTOM_LEFT | BOTTOM_RIGHT,
  "▌": TOP_LEFT | BOTTOM_LEFT,
  "▐": TOP_RIGHT | BOTTOM_RIGHT,
  "▘": TOP_LEFT,
  "▝": TOP_RIGHT,
  "▖": BOTTOM_LEFT,
  "▗": BOTTOM_RIGHT,
  "▚": TOP_LEFT | BOTTOM_RIGHT,
  "▞": TOP_RIGHT | BOTTOM_LEFT,
  "▙": TOP_LEFT | BOTTOM_LEFT | BOTTOM_RIGHT,
  "▛": TOP_LEFT | TOP_RIGHT | BOTTOM_LEFT,
  "▜": TOP_LEFT | TOP_RIGHT | BOTTOM_RIGHT,
  "▟": TOP_RIGHT | BOTTOM_LEFT | BOTTOM_RIGHT,
};

/** One frame as two fills: the full-coverage blocks and the dimmer partial ones. */
interface FrameGeometry {
  full: string;
  partial: string;
}

const round = (value: number) => Math.round(value * 100) / 100;

/**
 * Both colours arrive as ONE path each rather than a rectangle per block. Adjacent
 * rectangles are antialiased independently, so a shared edge blends twice and shows as
 * a seam through what should be solid; subpaths of a single fill are rasterised as one
 * shape and have no interior. It also keeps a frame to two nodes to swap, which is what
 * makes 80fps in React unremarkable.
 */
function buildFrameGeometry(rows: readonly SplashRow[]): FrameGeometry {
  const full: string[] = [];
  const partial: string[] = [];

  for (const [row, cells] of rows.entries()) {
    const [glyphs, partialColumns] = cells;
    const dimmed = partialColumns && partialColumns.length > 0 ? new Set(partialColumns) : null;

    // Half a block at a time, top half then bottom: a quadrant row is the finest the
    // frames resolve to, and horizontally adjacent quadrants of the same colour merge
    // into one rectangle.
    for (let half = 0; half < 2; half++) {
      const leftBit = half === 0 ? TOP_LEFT : BOTTOM_LEFT;
      const rightBit = half === 0 ? TOP_RIGHT : BOTTOM_RIGHT;
      const y = round((row + half * 0.5) * BLOCK_HEIGHT);
      const height = round(BLOCK_HEIGHT / 2);

      let runStart = -1;
      let runEnd = -1;
      let runDimmed = false;
      const flush = () => {
        if (runStart < 0) return;
        const x = round((runStart / 2 - MARK_COLUMN_OFFSET) * BLOCK_WIDTH);
        const width = round(((runEnd - runStart + 1) / 2) * BLOCK_WIDTH);
        (runDimmed ? partial : full).push(`M${x} ${y}h${width}v${height}h${-width}z`);
        runStart = -1;
      };

      for (let quadrant = 0; quadrant < glyphs.length * 2; quadrant++) {
        const column = quadrant >> 1;
        const bit = quadrant % 2 === 0 ? leftBit : rightBit;
        const filled = ((GLYPH_QUADRANTS[glyphs.charAt(column)] ?? 0) & bit) !== 0;
        const isDimmed = dimmed?.has(column) === true;
        if (filled && runStart >= 0 && isDimmed === runDimmed) {
          runEnd = quadrant;
          continue;
        }
        flush();
        if (filled) {
          runStart = quadrant;
          runEnd = quadrant;
          runDimmed = isDimmed;
        }
      }
      flush();
    }
  }

  return { full: full.join(""), partial: partial.join("") };
}

/** Built once per renderer realm, not once per boot: the frames never change. */
let geometryCache: FrameGeometry[] | null = null;
function frameGeometry(): FrameGeometry[] {
  geometryCache ??= SPLASH_FRAMES.map(buildFrameGeometry);
  return geometryCache;
}

export function AssistantBootSplash({ onDone, className }: AssistantBootSplashProps) {
  const [frame, setFrame] = useState(-1);
  const doneRef = useRef(onDone);
  // Kept current in an effect rather than during render: the reveal's timers outlive the
  // render that scheduled them, and writing a ref while rendering is a compiler error.
  useEffect(() => {
    doneRef.current = onDone;
  });

  // Honour reduced motion by showing the FINISHED mark rather than nothing: the mark
  // is the boot state's content, and removing it would leave a blank panel. Only the
  // drawing-in is motion. Read through the shared signal so the in-app "Reduce
  // animations" and performance-mode settings count, not just the OS media query — and
  // live, so turning either on mid-reveal lands the mark instead of finishing the draw.
  const skipMotion = useShouldSkipMotion();

  useEffect(() => {
    if (skipMotion) {
      const t = window.setTimeout(() => doneRef.current?.(), SPLASH_LINGER_MS);
      return () => clearTimeout(t);
    }

    // Paced against ABSOLUTE deadlines from one start instant, not a fixed delay per
    // frame: a per-frame timeout stacks render time onto every tick, so a busy renderer
    // stretches a 500ms animation into something visibly slower. Dropping frames to
    // stay on schedule is the right trade — the mark still lands on time.
    //
    // The wait is part of that same schedule rather than a timeout in front of it, so a
    // renderer busy through the slide spends the delay it owes and starts the draw where
    // the clock says, not where the first idle frame happens to fall.
    const started = performance.now() + REVEAL_DELAY;
    let raf = 0;
    let linger = 0;
    const tick = () => {
      const elapsed = performance.now() - started;
      if (elapsed < 0) {
        raf = requestAnimationFrame(tick);
        return;
      }
      const idx = Math.min(SPLASH_FRAMES.length - 1, Math.floor(elapsed / FRAME_MS));
      setFrame(idx);
      if (idx < SPLASH_FRAMES.length - 1) {
        raf = requestAnimationFrame(tick);
        return;
      }
      raf = 0;
      // Held to the ORIGINAL deadline rather than starting from whenever frame 39
      // happened to paint. requestAnimationFrame can only paint at the display's
      // refresh rate, so on 60Hz the last frame lands early and a linger measured from
      // it would cut the total short by up to a frame.
      const remaining = Math.max(0, FRAME_MS * SPLASH_FRAMES.length - elapsed);
      linger = window.setTimeout(() => doneRef.current?.(), remaining + SPLASH_LINGER_MS);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      // Cleared too: without this a completed run still fires `onDone` after unmount,
      // which on a remount reports the NEW run finished before it has drawn a frame.
      if (linger) clearTimeout(linger);
    };
  }, [skipMotion]);

  const frames = frameGeometry();
  const finished = frames[frames.length - 1];
  // Skipped motion picks the finished mark HERE rather than seeking to it in the effect:
  // an effect runs after the first paint, so the first frame would flash first. Nothing
  // is drawn before frame 0 — the grid is mounted and holding its space through the
  // panel's slide, which is what keeps the mark from landing in a moving panel.
  const geometry = skipMotion ? finished : frame < 0 ? undefined : (frames[frame] ?? finished);

  return (
    <div
      className={className}
      // Presentational: a screen reader announcing a 48-column block mark would be
      // noise. The status the splash stands for is announced by the connection line.
      aria-hidden="true"
    >
      <svg
        // The viewBox is the mark's own bounding box, so the aspect ratio is fixed by
        // the artwork and the element just scales inside it: full width in a narrow
        // panel, capped in a wide one, never distorted and never clipped.
        viewBox={`0 0 ${MARK_WIDTH} ${MARK_HEIGHT}`}
        // Classed for the forced-colors rule in index.css: a fill is not a colour, so
        // Windows high contrast leaves it author-painted unless it is named there.
        className="assistant-boot-mark mx-auto block h-auto w-full"
        style={{ maxWidth: MAX_MARK_WIDTH }}
      >
        {geometry?.full ? <path d={geometry.full} fill={SPLASH_COLOR_FULL} /> : null}
        {geometry?.partial ? <path d={geometry.partial} fill={SPLASH_COLOR_PARTIAL} /> : null}
      </svg>
    </div>
  );
}
