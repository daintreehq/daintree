import { useCallback, useEffect, useRef, useState } from "react";
import { buildDaintreeFileUrl } from "./filePreviewKinds";
import { TRANSPARENCY_CHECKERBOARD_STYLE } from "./transparencyCheckerboard";
import { cn } from "@/lib/utils";
import { Minus, Plus } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export interface ZoomableImageProps {
  /** Absolute path of the image. */
  filePath: string;
  /** Known root the `daintree-file://` protocol resolves the path against. */
  rootPath: string;
  /** Alt text — the file name, so a broken image still names its file. */
  alt: string;
  /**
   * Opaque token appended to the URL so a rewritten file is refetched. Changing
   * it reloads the bytes without remounting, which is what preserves the
   * current zoom and pan.
   */
  cacheBust?: string;
  onError?: () => void;
}

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 16;
const WHEEL_ZOOM_SENSITIVITY = 0.0015;

/** Clamp a zoom factor into the supported range. Exported for tests. */
export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/**
 * Zoom factor a wheel gesture should produce. Multiplicative rather than
 * additive so a step feels the same at every magnification — an additive step
 * crawls when zoomed out and overshoots when zoomed in.
 */
export function zoomForWheel(currentZoom: number, deltaY: number): number {
  return clampZoom(currentZoom * Math.exp(-deltaY * WHEEL_ZOOM_SENSITIVITY));
}

/** How far one arrow press pans a zoomed image, in CSS px. */
const KEYBOARD_PAN_STEP = 48;

/** Multiplier one press of the zoom buttons applies. */
const BUTTON_ZOOM_STEP = 1.25;

/**
 * How much of its natural size the image is drawn at when it fits the stage:
 * `max-w-full max-h-full` only ever shrinks, so this is capped at 1. Exported
 * for tests.
 */
export function fitScale(
  natural: { width: number; height: number } | null,
  stage: { width: number; height: number } | null
): number {
  if (!natural || !stage || natural.width <= 0 || natural.height <= 0) return 1;
  if (stage.width <= 0 || stage.height <= 0) return 1;
  return Math.min(1, stage.width / natural.width, stage.height / natural.height);
}

/**
 * Read-only image surface with a transparency checkerboard, wheel zoom and
 * drag pan.
 *
 * Separate from `FileImagePreview` rather than an option on it: that component
 * is a plain fit-to-box `<img>` used by the file panel and the viewer modal,
 * and giving it a pan/zoom mode would put an interaction surface into two
 * places that deliberately have none.
 */
export function ZoomableImage({ filePath, rootPath, alt, cacheBust, onError }: ZoomableImageProps) {
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number } | null>(null);
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const [stage, setStage] = useState<{ width: number; height: number } | null>(null);

  useEffect(() => {
    const element = containerRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      setStage({ width: element.clientWidth, height: element.clientHeight });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Every file gets a fresh view. Without this, opening a second image inherits
  // the previous one's zoom and pan, which reads as a broken image when the two
  // have different dimensions.
  useEffect(() => {
    setZoom(1);
    setOffset({ x: 0, y: 0 });
    setNatural(null);
  }, [filePath]);

  const resetView = useCallback(() => {
    setZoom(1);
    setOffset({ x: 0, y: 0 });
  }, []);

  // Registered natively rather than via onWheel because React attaches wheel
  // listeners as passive, and a passive listener cannot preventDefault — the
  // page would scroll behind the zoom.
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      setZoom((current) => zoomForWheel(current, event.deltaY));
    };
    element.addEventListener("wheel", handleWheel, { passive: false });
    return () => element.removeEventListener("wheel", handleWheel);
  }, []);

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX - offset.x,
      startY: event.clientY - offset.y,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setOffset({ x: event.clientX - drag.startX, y: event.clientY - drag.startY });
  };

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const isZoomed = zoom !== 1 || offset.x !== 0 || offset.y !== 0;

  // The keyboard's route to everything the wheel and the drag do: arrows pan,
  // + and - zoom, 0 fits. Panning is the part the footer buttons can't give,
  // and without it a zoomed image's edges are reachable only by pointer.
  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const pan: Record<string, [number, number]> = {
      ArrowLeft: [KEYBOARD_PAN_STEP, 0],
      ArrowRight: [-KEYBOARD_PAN_STEP, 0],
      ArrowUp: [0, KEYBOARD_PAN_STEP],
      ArrowDown: [0, -KEYBOARD_PAN_STEP],
    };
    const delta = pan[event.key];
    if (delta) {
      event.preventDefault();
      setOffset((current) => ({ x: current.x + delta[0], y: current.y + delta[1] }));
      return;
    }
    if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      setZoom((current) => clampZoom(current * BUTTON_ZOOM_STEP));
    } else if (event.key === "-") {
      event.preventDefault();
      setZoom((current) => clampZoom(current / BUTTON_ZOOM_STEP));
    } else if (event.key === "0") {
      event.preventDefault();
      resetView();
    }
  };
  // What the reader is actually looking at, as a share of the image's own
  // pixels. The transform multiplier alone said "100%" for an image the stage
  // had already shrunk to a third of its size.
  const shownPercent = Math.round(fitScale(natural, stage) * zoom * 100);

  return (
    <div className="relative flex h-full min-h-0 w-full flex-col">
      <div
        ref={containerRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={resetView}
        onKeyDown={handleKeyDown}
        tabIndex={0}
        role="group"
        aria-label={`${alt}. Arrow keys pan, plus and minus zoom, 0 fits to screen.`}
        style={TRANSPARENCY_CHECKERBOARD_STYLE}
        className={cn(
          // select-none so drag-panning never starts a text/image selection that
          // would paint the selection highlight over the image (#11325).
          "flex h-full min-h-0 w-full flex-1 select-none items-center justify-center overflow-hidden",
          "focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-primary",
          isZoomed ? "cursor-grab" : "cursor-default"
        )}
      >
        <img
          // Keyed by path so switching files remounts rather than showing the
          // previous image until the new one decodes.
          key={filePath}
          src={
            cacheBust === undefined
              ? buildDaintreeFileUrl(filePath, rootPath)
              : `${buildDaintreeFileUrl(filePath, rootPath)}&v=${encodeURIComponent(cacheBust)}`
          }
          alt={alt}
          draggable={false}
          onError={onError}
          onLoad={(event) =>
            setNatural({
              width: event.currentTarget.naturalWidth,
              height: event.currentTarget.naturalHeight,
            })
          }
          style={{
            transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
          }}
          className="max-h-full max-w-full object-contain"
        />
      </div>
      {/* The image's facts on the left — its own size, and how much of it is
          on screen — and the view controls on the right, reachable without a
          wheel or a drag. */}
      <div className="flex shrink-0 items-center gap-2 border-t border-border-default px-3 py-1 text-2xs text-text-secondary">
        <span className="min-w-0 flex-1 truncate tabular-nums" data-testid="zoomable-image-status">
          {natural && (
            <>
              {natural.width} × {natural.height}
              <span aria-hidden="true" className="px-1.5">
                ·
              </span>
            </>
          )}
          {isZoomed ? `${shownPercent}%` : `Fit, ${shownPercent}%`}
        </span>
        <ZoomButton
          label="Zoom out"
          disabled={zoom <= MIN_ZOOM}
          onClick={() => setZoom((current) => clampZoom(current / BUTTON_ZOOM_STEP))}
        >
          <Minus className="h-3.5 w-3.5" aria-hidden="true" />
        </ZoomButton>
        <ZoomButton
          label="Zoom in"
          disabled={zoom >= MAX_ZOOM}
          onClick={() => setZoom((current) => clampZoom(current * BUTTON_ZOOM_STEP))}
        >
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
        </ZoomButton>
        <button
          type="button"
          onClick={resetView}
          disabled={!isZoomed}
          className="shrink-0 rounded-lg px-2 py-1 text-text-secondary transition-colors duration-150 ease-out hover:bg-overlay-subtle hover:text-text-primary disabled:opacity-50"
        >
          Fit to screen
        </button>
      </div>
    </div>
  );
}

function ZoomButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg text-text-secondary transition-colors duration-150 ease-out hover:bg-overlay-subtle hover:text-text-primary disabled:opacity-50"
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  );
}
