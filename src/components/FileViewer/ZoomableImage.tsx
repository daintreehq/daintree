import { useCallback, useEffect, useRef, useState } from "react";
import { buildDaintreeFileUrl } from "./filePreviewKinds";
import { useImageErrorHandler } from "./previewRefusal";
import { transparencyCheckerboardUnderScale } from "./transparencyCheckerboard";
import type { MediaPreviewError } from "./useMediaSourceUrl";
import { cn } from "@/lib/utils";
import {
  PANE_STATUS_FOOTER_CLASS,
  PANE_TOOLBAR_ICON_BUTTON_CLASS,
  PANE_TOOLBAR_ICON_CLASS,
  PANE_TOOLBAR_TEXT_BUTTON_CLASS,
} from "@/components/ui/paneToolbarStyles";
import { Minus, Plus } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useToolbarRoving } from "@/hooks/useToolbarRoving";

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
  /** Called with the host's refusal when a remote window's host refused it; bare for a failed load. */
  onError?: (error?: MediaPreviewError) => void;
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

export interface ZoomView {
  zoom: number;
  /** Pan, in CSS px from where the stage centres the image. */
  offset: { x: number; y: number };
}

const FIT_VIEW: ZoomView = { zoom: 1, offset: { x: 0, y: 0 } };

/**
 * The view after zooming to `nextZoom` while the image point under `anchor`
 * stays where it is on screen. `anchor` is a stage position measured from the
 * stage's centre. The image is centred in the stage and scales about its own
 * centre, which sits at the stage centre plus `offset`, so the pan has to take
 * up whatever the scale change moves the anchored point by. Exported for tests.
 */
export function zoomViewAt(
  view: ZoomView,
  nextZoom: number,
  anchor: { x: number; y: number }
): ZoomView {
  const zoom = clampZoom(nextZoom);
  // Pinned at a limit, nothing moves: returning the same object also spares a render.
  if (zoom === view.zoom) return view;
  const ratio = zoom / view.zoom;
  return {
    zoom,
    offset: {
      x: anchor.x - (anchor.x - view.offset.x) * ratio,
      y: anchor.y - (anchor.y - view.offset.y) * ratio,
    },
  };
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
 * Raster images in the file panel and the File Browser viewer both render
 * through this, so the two views zoom and pan the same way.
 *
 * Separate from `FileImagePreview` rather than an option on it: that component
 * is a plain fit-to-box `<img>` that also carries SVG, and the fit-only
 * surfaces (SVG, the temporary viewer dialog) deliberately have no interaction
 * surface to give a pan/zoom mode to.
 */
export function ZoomableImage({ filePath, rootPath, alt, cacheBust, onError }: ZoomableImageProps) {
  const [view, setView] = useState<ZoomView>(FIT_VIEW);
  const { zoom, offset } = view;
  const containerRef = useRef<HTMLDivElement>(null);
  const controlsRef = useRef<HTMLDivElement>(null);
  const handleControlsKeyDown = useToolbarRoving(controlsRef);
  const dragRef = useRef<{ pointerId: number; lastX: number; lastY: number } | null>(null);
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const [stage, setStage] = useState<{ width: number; height: number } | null>(null);
  const src =
    cacheBust === undefined
      ? buildDaintreeFileUrl(filePath, rootPath)
      : `${buildDaintreeFileUrl(filePath, rootPath)}&v=${encodeURIComponent(cacheBust)}`;
  const handleError = useImageErrorHandler(src, onError);

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
    setView(FIT_VIEW);
    setNatural(null);
  }, [filePath]);

  const resetView = useCallback(() => setView(FIT_VIEW), []);

  // Keeps the current pan, so the image zooms about its own centre.
  const stepZoom = (factor: number) =>
    setView((current) => ({ ...current, zoom: clampZoom(current.zoom * factor) }));

  // Registered natively rather than via onWheel because React attaches wheel
  // listeners as passive, and a passive listener cannot preventDefault — the
  // page would scroll behind the zoom.
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      // Measured here, not in the updater: wheel events can land several to a
      // frame, and each one has to compose onto the view the last one left.
      const rect = element.getBoundingClientRect();
      const anchor = {
        x: event.clientX - (rect.left + rect.width / 2),
        y: event.clientY - (rect.top + rect.height / 2),
      };
      setView((current) => zoomViewAt(current, zoomForWheel(current.zoom, event.deltaY), anchor));
    };
    element.addEventListener("wheel", handleWheel, { passive: false });
    return () => element.removeEventListener("wheel", handleWheel);
  }, []);

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    // Control-click is the context menu on macOS: leave it uncaptured.
    if (event.button !== 0 || event.ctrlKey) return;
    dragRef.current = { pointerId: event.pointerId, lastX: event.clientX, lastY: event.clientY };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    // Applied as a step rather than measured from where the press began, so a
    // wheel zoom mid-drag keeps the pan it made.
    const dx = event.clientX - drag.lastX;
    const dy = event.clientY - drag.lastY;
    drag.lastX = event.clientX;
    drag.lastY = event.clientY;
    setView((current) => ({
      ...current,
      offset: { x: current.offset.x + dx, y: current.offset.y + dy },
    }));
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
    // Chords belong to the app: Cmd+arrows move between panels and Cmd+/-/0 are
    // its own zoom. Shift stays ours, since `+` is Shift+= on most layouts.
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const pan: Record<string, [number, number]> = {
      ArrowLeft: [KEYBOARD_PAN_STEP, 0],
      ArrowRight: [-KEYBOARD_PAN_STEP, 0],
      ArrowUp: [0, KEYBOARD_PAN_STEP],
      ArrowDown: [0, -KEYBOARD_PAN_STEP],
    };
    const delta = pan[event.key];
    if (delta) {
      event.preventDefault();
      // Stopped so the grid's arrow-key panel navigation, which doesn't check
      // `defaultPrevented`, doesn't also move focus away.
      event.stopPropagation();
      setView((current) => ({
        ...current,
        offset: { x: current.offset.x + delta[0], y: current.offset.y + delta[1] },
      }));
      return;
    }
    if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      event.stopPropagation();
      stepZoom(BUTTON_ZOOM_STEP);
    } else if (event.key === "-") {
      event.preventDefault();
      event.stopPropagation();
      stepZoom(1 / BUTTON_ZOOM_STEP);
    } else if (event.key === "0") {
      event.preventDefault();
      event.stopPropagation();
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
        onLostPointerCapture={endDrag}
        onDoubleClick={resetView}
        onKeyDown={handleKeyDown}
        tabIndex={0}
        role="group"
        aria-label={`${alt}. Arrow keys pan, plus and minus zoom, 0 fits to screen.`}
        className={cn(
          // select-none so drag-panning never starts a text/image selection that
          // would paint the selection highlight over the image (#11325).
          "relative flex h-full min-h-0 w-full flex-1 select-none items-center justify-center overflow-hidden",
          // The ring is drawn on a layer over the picture: the image's transform
          // paints it above the stage's own outline, which hid the ring where the
          // image meets the stage's edges (all of them once zoomed in).
          "after:pointer-events-none after:absolute after:inset-0 after:z-10 after:content-['']",
          "focus-visible:outline-hidden focus-visible:after:outline focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-accent-primary",
          isZoomed ? "cursor-grab" : "cursor-default"
        )}
      >
        <img
          // Keyed by path so switching files remounts rather than showing the
          // previous image until the new one decodes.
          key={filePath}
          src={src}
          alt={alt}
          draggable={false}
          onError={handleError}
          onLoad={(event) =>
            setNatural({
              width: event.currentTarget.naturalWidth,
              height: event.currentTarget.naturalHeight,
            })
          }
          style={{
            ...transparencyCheckerboardUnderScale(zoom),
            transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
          }}
          className="max-h-full max-w-full object-contain"
        />
      </div>
      {/* The image's facts on the left — its own size, and how much of it is
          on screen — and the view controls on the right, reachable without a
          wheel or a drag. */}
      {/* Wraps rather than truncates: at a narrow width the facts drop to
          their own line instead of losing the scale off the end. */}
      <div // No vertical padding: the zoom buttons are 26px on their own, so
        // `py-1` would make this the one 34px strip among 24px siblings.
        className={cn(PANE_STATUS_FOOTER_CLASS, "flex-wrap justify-between gap-x-2 gap-y-0.5 py-0")}
      >
        <span role="status" className="tabular-nums" data-testid="zoomable-image-status">
          {natural && (
            <span className="whitespace-nowrap">
              {natural.width} × {natural.height}
              <span aria-hidden="true" className="px-1.5">
                ·
              </span>
            </span>
          )}
          <span className="whitespace-nowrap">
            {isZoomed ? `${shownPercent}%` : `Fit, ${shownPercent}%`}
          </span>
        </span>
        {/* One tab stop with Left/Right between the three, the same toolbar
            contract as the viewer's header. */}
        <div
          ref={controlsRef}
          role="toolbar"
          aria-label="Zoom controls"
          onKeyDown={handleControlsKeyDown}
          className="ml-auto flex shrink-0 items-center gap-2"
        >
          <ZoomButton
            label="Zoom out"
            disabled={zoom <= MIN_ZOOM}
            onClick={() => stepZoom(1 / BUTTON_ZOOM_STEP)}
          >
            <Minus className={PANE_TOOLBAR_ICON_CLASS} aria-hidden="true" />
          </ZoomButton>
          <ZoomButton
            label="Zoom in"
            disabled={zoom >= MAX_ZOOM}
            onClick={() => stepZoom(BUTTON_ZOOM_STEP)}
          >
            <Plus className={PANE_TOOLBAR_ICON_CLASS} aria-hidden="true" />
          </ZoomButton>
          <button
            type="button"
            onClick={() => {
              if (isZoomed) resetView();
            }}
            aria-disabled={!isZoomed || undefined}
            className={PANE_TOOLBAR_TEXT_BUTTON_CLASS}
          >
            Fit to screen
          </button>
        </div>
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
          // aria-disabled, not disabled: an unavailable zoom step keeps its
          // place in the toolbar's arrow-key order and its tooltip.
          aria-disabled={disabled || undefined}
          onClick={() => {
            if (!disabled) onClick();
          }}
          className={PANE_TOOLBAR_ICON_BUTTON_CLASS}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  );
}
