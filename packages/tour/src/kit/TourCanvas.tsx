import {
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react";
import { cn } from "./cn.js";

/** Scenes are authored on a fixed canvas and scaled to fit the stage. */
export const TOUR_CANVAS = { width: 640, height: 360 } as const;

/**
 * The stage a scene plays on: a 16:9 frame that scales the fixed 640×360
 * canvas to its width. `overlay` sits over the canvas unscaled, for controls.
 * `wrapStage` wraps the scaled canvas in the unscaled frame, e.g. in an error
 * boundary whose fallback must stay outside the aria-hidden canvas.
 */
export function TourCanvas({
  ref,
  canvasKey,
  overlay,
  wrapStage,
  className,
  children,
}: {
  ref?: Ref<HTMLDivElement>;
  /** Changing this remounts the canvas, and its entrance, but not the overlay. */
  canvasKey?: string;
  overlay?: ReactNode;
  wrapStage?: (canvas: ReactNode) => ReactNode;
  className?: string;
  children?: ReactNode;
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useImperativeHandle(ref, () => frameRef.current!, []);

  useLayoutEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const measure = () => setScale(el.clientWidth / TOUR_CANVAS.width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // The mockup is illustration; the chapter title and captions carry the content.
  const canvas = (
    <div
      key={canvasKey}
      aria-hidden="true"
      data-tour-canvas=""
      className="absolute left-0 top-0 origin-top-left motion-safe:animate-in motion-safe:fade-in motion-safe:[--tw-animation-duration:var(--duration-200)]"
      style={{ width: TOUR_CANVAS.width, height: TOUR_CANVAS.height, scale: String(scale) }}
    >
      {children}
    </div>
  );

  return (
    <div
      ref={frameRef}
      className={cn(
        "relative aspect-video w-full select-none overflow-hidden bg-surface-canvas",
        className
      )}
    >
      {wrapStage ? wrapStage(canvas) : canvas}
      {overlay}
    </div>
  );
}
