import { useCallback, useEffect, useRef, useState } from "react";
import { buildDaintreeFileUrl } from "./filePreviewKinds";
import { TRANSPARENCY_CHECKERBOARD_STYLE } from "./transparencyCheckerboard";
import { cn } from "@/lib/utils";

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

  // Every file gets a fresh view. Without this, opening a second image inherits
  // the previous one's zoom and pan, which reads as a broken image when the two
  // have different dimensions.
  useEffect(() => {
    setZoom(1);
    setOffset({ x: 0, y: 0 });
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

  return (
    <div className="relative flex h-full min-h-0 w-full flex-col">
      <div
        ref={containerRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={resetView}
        style={TRANSPARENCY_CHECKERBOARD_STYLE}
        className={cn(
          // select-none so drag-panning never starts a text/image selection that
          // would paint the selection highlight over the image (#11325).
          "flex h-full min-h-0 w-full flex-1 select-none items-center justify-center overflow-hidden",
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
          style={{
            transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
          }}
          className="max-h-full max-w-full object-contain"
        />
      </div>
      <div className="flex shrink-0 items-center justify-between border-t border-border-default px-3 py-1 text-2xs text-muted-foreground">
        <span>{Math.round(zoom * 100)}%</span>
        <button
          type="button"
          onClick={resetView}
          disabled={!isZoomed}
          className="rounded px-2 py-0.5 transition-colors duration-150 ease-out hover:bg-overlay-subtle disabled:opacity-40"
        >
          Fit to screen
        </button>
      </div>
    </div>
  );
}
