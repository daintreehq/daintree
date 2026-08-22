import { useEffect, useMemo, useRef, useState } from "react";
import {
  SPLASH_COLOR_FULL,
  SPLASH_COLOR_PARTIAL,
  SPLASH_FPS,
  SPLASH_FRAMES,
  SPLASH_LINGER_MS,
  SPLASH_WIDTH,
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
 * ## Why it is character cells rather than an SVG
 *
 * Because the original is. The mark is a vector clipped by animated mask strokes and
 * then supersampled onto a terminal grid — the blockiness is the look, not a limitation
 * being worked around. Re-animating the SVG directly would be smoother and would not be
 * the same thing.
 *
 * The splash covers real work: MCP connect, backend handshake and project resolution
 * all land inside the ~740ms it runs. It is not a fake delay — `done` fires on its own
 * timeline and the panel is interactive underneath the whole time, exactly as the
 * cockpit's composer was live while its splash played.
 */

export interface AssistantBootSplashProps {
  /** Called once the reveal and its linger have finished. */
  onDone?: () => void;
  className?: string;
}

const FRAME_MS = 1000 / SPLASH_FPS;

/** One row, rendered as spans so partial cells take the dimmer colour. */
function Row({ row }: { row: SplashRow }) {
  const [glyphs, partial] = row;
  if (!partial || partial.length === 0) {
    return <span style={{ color: SPLASH_COLOR_FULL }}>{glyphs}</span>;
  }
  const partialSet = new Set(partial);
  const out: React.ReactNode[] = [];
  let run = "";
  let runPartial = partialSet.has(0);
  for (let i = 0; i < glyphs.length; i++) {
    const isPartial = partialSet.has(i);
    if (isPartial !== runPartial && run) {
      out.push(
        <span
          key={i - run.length}
          style={{ color: runPartial ? SPLASH_COLOR_PARTIAL : SPLASH_COLOR_FULL }}
        >
          {run}
        </span>
      );
      run = "";
    }
    runPartial = isPartial;
    run += glyphs[i];
  }
  if (run) {
    out.push(
      <span key="tail" style={{ color: runPartial ? SPLASH_COLOR_PARTIAL : SPLASH_COLOR_FULL }}>
        {run}
      </span>
    );
  }
  return <>{out}</>;
}

export function AssistantBootSplash({ onDone, className }: AssistantBootSplashProps) {
  const [frame, setFrame] = useState(0);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  // Honour reduced motion by showing the FINISHED mark rather than nothing: the mark
  // is the boot state's content, and removing it would leave a blank panel. Only the
  // drawing-in is motion.
  const reduced = useMemo(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true,
    []
  );

  useEffect(() => {
    if (reduced) {
      setFrame(SPLASH_FRAMES.length - 1);
      const t = window.setTimeout(() => doneRef.current?.(), SPLASH_LINGER_MS);
      return () => clearTimeout(t);
    }

    // Paced against ABSOLUTE deadlines from one start instant, not a fixed delay per
    // frame: a per-frame timeout stacks render time onto every tick, so a busy renderer
    // stretches a 500ms animation into something visibly slower. Dropping frames to
    // stay on schedule is the right trade — the mark still lands on time.
    const started = performance.now();
    let raf = 0;
    let linger = 0;
    const tick = () => {
      const elapsed = performance.now() - started;
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
  }, [reduced]);

  const rows = SPLASH_FRAMES[frame] ?? SPLASH_FRAMES[SPLASH_FRAMES.length - 1] ?? [];

  return (
    <div
      className={className}
      // Presentational: a screen reader announcing 48 columns of block glyphs would be
      // noise. The status the splash stands for is announced by the connection line.
      aria-hidden="true"
    >
      <pre
        className="m-0 select-none overflow-hidden font-mono leading-none"
        style={{
          // Sized in ch so the grid holds its aspect however the panel is scaled, and
          // clamped so a narrow sidebar shrinks the mark instead of clipping it.
          fontSize: `clamp(4px, calc(100cqw / ${SPLASH_WIDTH} / 0.6), 12px)`,
        }}
      >
        {rows.map((row, i) => (
          <div key={i}>
            <Row row={row} />
          </div>
        ))}
      </pre>
    </div>
  );
}
