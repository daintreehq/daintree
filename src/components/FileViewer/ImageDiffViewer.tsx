import { useCallback, useEffect, useRef, useState, type CSSProperties, type UIEvent } from "react";
import { GripVertical, ImageOff } from "lucide-react";
import type { DiffMediaFileVersions, DiffMediaSide, GitStatus } from "@shared/types";
import { getDiffMediaImageMime } from "@shared/types/ipc/diffMedia";
import { diffMediaClient } from "@/clients/diffMediaClient";
import { SegmentedToggle } from "@/components/ui/SegmentedToggle";
import { EmptyState } from "@/components/ui/EmptyState";
import { Button } from "@/components/ui/button";
import { Skeleton, SkeletonBone } from "@/components/ui/Skeleton";
import { useResizeObserverRaf } from "@/hooks/useResizeObserverRaf";
import { formatBytes } from "@/lib/formatBytes";
import { cn } from "@/lib/utils";
import { TRANSPARENCY_CHECKERBOARD_STYLE } from "./transparencyCheckerboard";

export interface ImageDiffViewerProps {
  /** Repo-relative path of the changed image */
  relPath: string;
  /** Worktree root (IPC cwd) */
  worktreePath: string;
  status: GitStatus;
}

export function isImageDiffCandidate(path: string): boolean {
  return getDiffMediaImageMime(path) !== null;
}

type ImageDiffMode = "two-up" | "swipe" | "onion";

const MODE_OPTIONS: Array<{ value: ImageDiffMode; label: string }> = [
  { value: "two-up", label: "Two-up" },
  { value: "swipe", label: "Swipe" },
  { value: "onion", label: "Onion skin" },
];

type ImageZoom = "fit" | "actual";

interface ZoomControl {
  level: ImageZoom;
  /** Reports the fitted scale upward, so the viewer can tell when 100% would change nothing. */
  onFitScale: (scale: number | null) => void;
}

const ZOOM_OPTIONS: Array<{ value: ImageZoom; label: string; ariaLabel: string }> = [
  { value: "fit", label: "Fit", ariaLabel: "Fit to screen" },
  { value: "actual", label: "100%", ariaLabel: "Actual size" },
];

const SWIPE_KEYBOARD_STEP = 2;
const SWIPE_PAGE_STEP = 10;

const CHECKERBOARD_STYLE: CSSProperties = TRANSPARENCY_CHECKERBOARD_STYLE;

type OkSide = Extract<DiffMediaSide, { ok: true }>;

interface ImageDims {
  width: number;
  height: number;
}

type ImageDiffStatusSide = "head" | "working";

type SideDims = Record<ImageDiffStatusSide, ImageDims | null>;

function sideErrorMessage(error: Extract<DiffMediaSide, { ok: false }>["error"]): string {
  switch (error) {
    case "TOO_LARGE":
      return "Image too large to compare (over 8 MB)";
    case "UNSUPPORTED":
      return "This file format can't be previewed as an image";
    case "NOT_FOUND":
      return "No version to show";
    case "ERROR":
      return "Couldn't load this version";
  }
}

/** Where the swipe divider is, in words — the number alone doesn't say which version shows. */
export function swipeValueText(position: number): string {
  const head = Math.round(position);
  if (head <= 0) return "Working tree only";
  if (head >= 100) return "HEAD only";
  return `HEAD ${head}% on the left, working tree ${100 - head}% on the right`;
}

/** The slider keyboard contract (APG): arrows step, pages jump further, Home/End hit the ends. */
export function nextSwipePosition(key: string, current: number): number | null {
  const clamp = (value: number) => Math.min(100, Math.max(0, value));
  switch (key) {
    case "ArrowLeft":
    case "ArrowDown":
      return clamp(current - SWIPE_KEYBOARD_STEP);
    case "ArrowRight":
    case "ArrowUp":
      return clamp(current + SWIPE_KEYBOARD_STEP);
    case "PageDown":
      return clamp(current - SWIPE_PAGE_STEP);
    case "PageUp":
      return clamp(current + SWIPE_PAGE_STEP);
    case "Home":
      return 0;
    case "End":
      return 100;
    default:
      return null;
  }
}

function formatSignedBytes(delta: number): string {
  return `${delta > 0 ? "+" : "−"}${formatBytes(Math.abs(delta))}`;
}

/**
 * One side's facts, with the change against the other side spelled out so the
 * reader never has to subtract two captions. Only the working tree carries a
 * baseline — HEAD is what it changed from.
 */
export function imageFactParts(
  side: OkSide,
  dims: ImageDims | null,
  baseline?: { side: OkSide; dims: ImageDims | null }
): string[] {
  const parts: string[] = [];
  if (dims) {
    const was =
      baseline?.dims && (baseline.dims.width !== dims.width || baseline.dims.height !== dims.height)
        ? ` (was ${baseline.dims.width} × ${baseline.dims.height})`
        : "";
    parts.push(`${dims.width} × ${dims.height}${was}`);
  }
  const byteDelta = baseline ? side.byteSize - baseline.side.byteSize : 0;
  parts.push(
    byteDelta === 0
      ? formatBytes(side.byteSize)
      : `${formatBytes(side.byteSize)} (${formatSignedBytes(byteDelta)})`
  );
  return parts;
}

export function describeImageFacts(...args: Parameters<typeof imageFactParts>): string {
  return imageFactParts(...args).join(" · ");
}

/** The smallest box both versions fit in, anchored at a shared top-left origin. */
function unionDims(a: ImageDims | null, b: ImageDims | null): ImageDims | null {
  if (!a) return b;
  if (!b) return a;
  return { width: Math.max(a.width, b.width), height: Math.max(a.height, b.height) };
}

/**
 * One scale for every version on screen, measured against the frame. Fitting
 * each image on its own (`object-contain`) gives two differently sized versions
 * two different scales, which reads as a content change that never happened.
 * Never upscales: a 64px icon stays 64px rather than blurring to fill the pane.
 * Null until the frame has been measured or when the natural size is unknown,
 * and callers fall back to fitting each image independently. At "actual" the
 * scale is 1 and the frame scrolls instead.
 */
function useFitScale(
  box: ImageDims | null,
  zoom: ZoomControl
): [(el: HTMLDivElement | null) => void, number | null] {
  const [frame, setFrame] = useState<HTMLDivElement | null>(null);
  const [size, setSize] = useState<ImageDims | null>(null);
  useResizeObserverRaf(frame, (entry) => {
    const { width, height } = entry.contentRect;
    setSize((prev) =>
      prev && prev.width === width && prev.height === height ? prev : { width, height }
    );
  });
  const fitScale =
    box && size && size.width > 0 && size.height > 0 && box.width > 0 && box.height > 0
      ? Math.min(1, size.width / box.width, size.height / box.height)
      : null;
  const { onFitScale } = zoom;
  useEffect(() => {
    onFitScale(fitScale);
  }, [fitScale, onFitScale]);
  if (zoom.level === "actual" && box) return [setFrame, 1];
  return [setFrame, fitScale];
}

function scaledSize(dims: ImageDims, scale: number): CSSProperties {
  return { width: Math.round(dims.width * scale), height: Math.round(dims.height * scale) };
}

function SideChip({ label }: { label: string }) {
  // Opaque on purpose: it floats over arbitrary image content in the overlay modes.
  return (
    <span className="rounded-sm border border-border-default bg-surface-panel-elevated px-1.5 py-0.5 text-3xs font-medium text-text-secondary">
      {label}
    </span>
  );
}

/**
 * Always rendered, so a pane with nothing to report keeps its frame aligned
 * with its neighbour's. Wraps between facts rather than truncating: the change
 * it reports is the part a narrow pane would otherwise clip first.
 */
function FactsLine({ parts, className }: { parts?: string[]; className?: string }) {
  return (
    <p
      className={cn(
        "min-h-4 min-w-0 text-2xs tabular-nums text-text-secondary [overflow-wrap:anywhere]",
        className
      )}
      aria-hidden={parts ? undefined : true}
    >
      {parts
        ? parts.map((part, index) => (
            // Non-breaking inside a fact, breakable between them; `anywhere`
            // only fires when one fact alone is wider than the pane.
            <span key={part}>
              {/* The break falls before the dot, so it opens the next line
                  rather than dangling at the end of this one. */}
              {index > 0 ? " \u00b7\u00a0" : null}
              {part.replaceAll(" ", "\u00a0")}
            </span>
          ))
        : " "}
    </p>
  );
}

interface CommittedSnapshot {
  /** Identity of the fetch's *target* (worktree+path+status+nonce) — see makeRequestKey. */
  requestKey: string;
  /**
   * Monotonic id of the fetch attempt that produced this snapshot. Unlike
   * requestKey (deterministic per target, so it repeats when you navigate back
   * to a file), attempt is unique per fetch — keying each ImagePane by it forces
   * a remount on every commit, even when the same file recommits, so stale
   * per-side decode/dimension state can't survive a return visit.
   */
  attempt: number;
  versions: DiffMediaFileVersions;
  relPath: string;
  status: GitStatus;
  /**
   * Sides whose off-screen decode rejected, seeded into the matching ImagePane
   * so a genuinely broken image shows its per-side fallback instead of a torn
   * frame — and so the swap is never blocked by one bad side.
   */
  decodeFailures: { head: boolean; working: boolean };
  /** Natural size from the off-screen decode — what the shared scale is computed from. */
  dims: SideDims;
}

function deriveSingleSide(status: GitStatus): ImageDiffStatusSide | null {
  return status === "added" || status === "untracked"
    ? "working"
    : status === "deleted"
      ? "head"
      : null;
}

/** Sides a given status can actually render, so we never decode a hidden one. */
function renderableSides(status: GitStatus): ImageDiffStatusSide[] {
  const single = deriveSingleSide(status);
  return single === null ? ["head", "working"] : [single];
}

function makeRequestKey(
  worktreePath: string,
  relPath: string,
  status: GitStatus,
  nonce: number
): string {
  return JSON.stringify([worktreePath, relPath, status, nonce]);
}

/**
 * Decode a data URL on an off-screen element so the browser's URL-keyed
 * decoded-image cache is warm before the on-screen <img> mounts with the same
 * src — that's what lets the swap paint without a blank/torn frame (the
 * hold-then-swap pattern GitHub's PR viewer and VS Code's image preview use).
 * Resolves to whether the decode succeeded; a genuinely broken image resolves
 * `false` rather than throwing, so one bad side never blocks the whole swap.
 * `decode()` is absent under jsdom (and older engines), so guard for it.
 */
async function decodeOffscreen(dataUrl: string): Promise<{ ok: boolean; dims: ImageDims | null }> {
  const img = new Image();
  img.src = dataUrl;
  if (typeof img.decode !== "function") return { ok: true, dims: null };
  try {
    await img.decode();
    return {
      ok: true,
      dims:
        img.naturalWidth > 0 && img.naturalHeight > 0
          ? { width: img.naturalWidth, height: img.naturalHeight }
          : null,
    };
  } catch {
    return { ok: false, dims: null };
  }
}

/**
 * `safe` centring: a small image sits in the middle of its frame, a large one
 * starts at its top-left edge and scrolls, instead of centring its overflow
 * off the unreachable side.
 */
const PANE_FRAME_CLASS =
  "relative flex min-h-0 [align-items:safe_center] [justify-content:safe_center] rounded-md border border-border-default";

interface ScrollSync {
  register: (el: HTMLElement | null) => (() => void) | undefined;
  onScroll: (event: UIEvent<HTMLElement>) => void;
}

/** Keeps two-up frames on the same pixel at actual size, so both sides show the same region. */
function useScrollSync(): ScrollSync {
  // Created on first registration: a Set handed to useRef and then mutated is
  // a value the compiler treats as frozen.
  const members = useRef<Set<HTMLElement> | null>(null);
  const register = useCallback((el: HTMLElement | null) => {
    if (!el) return undefined;
    const set = (members.current ??= new Set());
    set.add(el);
    return () => {
      set.delete(el);
    };
  }, []);
  const onScroll = useCallback((event: UIEvent<HTMLElement>) => {
    const source = event.currentTarget;
    for (const el of members.current ?? []) {
      if (el === source) continue;
      if (el.scrollLeft !== source.scrollLeft) el.scrollLeft = source.scrollLeft;
      if (el.scrollTop !== source.scrollTop) el.scrollTop = source.scrollTop;
    }
  }, []);
  return { register, onScroll };
}

interface ImagePaneProps {
  label: string;
  side: DiffMediaSide;
  relPath: string;
  caption?: string;
  /** This version's natural size, when the predecode knew it. */
  dims: ImageDims | null;
  /** The box every pane in the comparison fits, so they share one scale. */
  fitBox: ImageDims | null;
  zoom: ZoomControl;
  /** Joins the pane to its siblings' scroll position at actual size. */
  scrollSync?: ScrollSync;
  /** What the facts line measures a change against (the working tree's HEAD). */
  baseline?: { side: OkSide; dims: ImageDims | null };
  /**
   * Seeded from the off-screen predecode so a side that failed to decode shows
   * the fallback on first paint. Each pane is keyed by the committed request +
   * side at the call site, so a new commit remounts it with fresh state — no
   * reset effect needed (the old [src] effect couldn't recover a same-URL
   * retry, since the src never changed).
   */
  initialDecodeFailed?: boolean;
  /** Offered only for transient read failures, not genuinely absent versions */
  onRetry?: () => void;
}

function ImagePane({
  label,
  side,
  relPath,
  caption,
  dims: knownDims,
  fitBox,
  zoom,
  scrollSync,
  baseline,
  initialDecodeFailed,
  onRetry,
}: ImagePaneProps) {
  const [loadedDims, setLoadedDims] = useState<ImageDims | null>(null);
  const [decodeFailed, setDecodeFailed] = useState(initialDecodeFailed ?? false);
  const [frameRef, scale] = useFitScale(fitBox, zoom);
  const dims = knownDims ?? loadedDims;
  const showImage = side.ok && !decodeFailed;
  const exact = scale !== null && knownDims !== null && fitBox !== null;

  return (
    // A subgrid of the caller's three rows (label, frame, facts), so a facts
    // line that wraps in one pane grows that row in both and the frames stay
    // the same height.
    <div className="row-span-3 grid min-h-0 min-w-0 grid-rows-subgrid">
      <div className="flex min-w-0 items-center gap-2">
        <SideChip label={label} />
        {caption ? <span className="truncate text-xs text-text-secondary">{caption}</span> : null}
      </div>
      <div
        ref={(el) => {
          frameRef(el);
          return scrollSync?.register(el);
        }}
        onScroll={scrollSync?.onScroll}
        data-image-frame=""
        className={cn(
          PANE_FRAME_CLASS,
          zoom.level === "actual" ? "overflow-auto" : "overflow-hidden"
        )}
      >
        {showImage && exact ? (
          // Every pane gets the same union-sized canvas with its image at the
          // top-left, so two-up lines up exactly as the overlay modes do and
          // both panes scroll over the same extent at 100%.
          <div className="relative shrink-0" style={scaledSize(fitBox, scale)}>
            <img
              src={side.dataUrl}
              alt={`${label} version of ${relPath}`}
              draggable={false}
              className="absolute left-0 top-0 max-w-none"
              style={{ ...CHECKERBOARD_STYLE, ...scaledSize(knownDims, scale) }}
              onError={() => setDecodeFailed(true)}
            />
          </div>
        ) : showImage ? (
          <img
            src={side.dataUrl}
            alt={`${label} version of ${relPath}`}
            draggable={false}
            className="max-h-full max-w-full object-contain"
            style={CHECKERBOARD_STYLE}
            onLoad={(event) =>
              setLoadedDims({
                width: event.currentTarget.naturalWidth,
                height: event.currentTarget.naturalHeight,
              })
            }
            onError={() => setDecodeFailed(true)}
          />
        ) : (
          <div className="flex flex-col items-center gap-2 px-4">
            <p className="text-center text-xs text-text-secondary">
              {side.ok
                ? "Couldn't decode this version — the file may be damaged"
                : sideErrorMessage(side.error)}
            </p>
            {!side.ok && side.error === "ERROR" && onRetry ? (
              <Button variant="outline" size="sm" onClick={onRetry}>
                Retry
              </Button>
            ) : null}
          </div>
        )}
      </div>
      <FactsLine parts={showImage ? imageFactParts(side, dims, baseline) : undefined} />
    </div>
  );
}

interface OkSides {
  head: OkSide;
  working: OkSide;
}

interface OverlayProps {
  sides: OkSides;
  dims: SideDims;
  relPath: string;
  zoom: ZoomControl;
}

/**
 * The shared geometry of the two overlay modes. With both natural sizes known,
 * the stage is the union of the two images at one shared scale, and each layer
 * sits at the stage's top-left at its own true size — so a resized version
 * shows as resized instead of being stretched to match. Without them it falls
 * back to both layers filling the frame with `object-contain`.
 */
function useOverlayGeometry(dims: SideDims, zoom: ZoomControl) {
  const box = dims.head && dims.working ? unionDims(dims.head, dims.working) : null;
  const [frameRef, scale] = useFitScale(box, zoom);
  const exact = scale !== null && box !== null;
  const stageStyle: CSSProperties = exact
    ? { position: "relative", ...scaledSize(box, scale), ...CHECKERBOARD_STYLE }
    : { position: "absolute", inset: 0, ...CHECKERBOARD_STYLE };
  const layerImg = (side: ImageDiffStatusSide) => {
    const sideDims = dims[side];
    return exact && sideDims
      ? {
          className: "absolute left-0 top-0 max-w-none",
          style: scaledSize(sideDims, scale),
        }
      : { className: "absolute inset-0 h-full w-full object-contain", style: undefined };
  };
  return { frameRef, stageStyle, layerImg };
}

function OverlayChips() {
  return (
    <>
      <div className="pointer-events-none absolute left-2 top-2 z-20">
        <SideChip label="HEAD" />
      </div>
      <div className="pointer-events-none absolute right-2 top-2 z-20">
        <SideChip label="Working tree" />
      </div>
    </>
  );
}

/** Both sides' facts under the overlay, each under its own corner label. */
function OverlayFacts({ sides, dims }: { sides: OkSides; dims: SideDims }) {
  return (
    <div className="flex shrink-0 justify-between gap-3 pt-1.5">
      <FactsLine parts={imageFactParts(sides.head, dims.head)} />
      <FactsLine
        className="text-right"
        parts={imageFactParts(sides.working, dims.working, { side: sides.head, dims: dims.head })}
      />
    </div>
  );
}

/** Label, frame, facts — shared by every pane in the row so their frames align. */
const PANE_ROWS_CLASS = "grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)_auto] gap-x-3 gap-y-1.5";

const OVERLAY_FRAME_CLASS =
  "relative flex min-h-0 flex-1 overflow-hidden rounded-md border border-border-default";

/**
 * The overlay's scroller sits inside the bordered frame rather than being it,
 * so the corner labels stay pinned while the stage scrolls at actual size.
 */
function overlayScrollerClass(zoom: ZoomControl): string {
  return cn(
    "absolute inset-0 flex [align-items:safe_center] [justify-content:safe_center]",
    zoom.level === "actual" ? "overflow-auto" : "overflow-hidden"
  );
}

function SwipeCompare({ sides, dims, relPath, zoom }: OverlayProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState(50);
  const draggingRef = useRef(false);
  const { frameRef, stageStyle, layerImg } = useOverlayGeometry(dims, zoom);

  // Measured against the stage, not the frame, so the divider tracks the image
  // rather than the letterbox around it. Clicks in the letterbox clamp to an end.
  const updateFromClientX = useCallback((clientX: number) => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    const next = ((clientX - rect.left) / rect.width) * 100;
    setPosition(Math.min(100, Math.max(0, next)));
  }, []);

  const head = layerImg("head");
  const working = layerImg("working");
  const dividerLeft = `round(nearest, ${position}%, 1px)`;
  // The line reaches both edges; the handle stops short of them, so it and its
  // focus ring are never clipped by a frame the image fills edge to edge.
  const handleLeft = `clamp(12px, ${dividerLeft}, calc(100% - 12px))`;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        className={cn(OVERLAY_FRAME_CLASS, "touch-none")}
        onPointerDown={(event) => {
          draggingRef.current = true;
          event.currentTarget.setPointerCapture(event.pointerId);
          updateFromClientX(event.clientX);
        }}
        onPointerMove={(event) => {
          if (draggingRef.current) updateFromClientX(event.clientX);
        }}
        onPointerUp={() => {
          draggingRef.current = false;
        }}
        onPointerCancel={() => {
          draggingRef.current = false;
        }}
      >
        <div ref={frameRef} className={overlayScrollerClass(zoom)}>
          <div ref={stageRef} style={stageStyle}>
            {/* Complementary clips over one shared stage: HEAD only left of the
              divider, the working tree only right of it. Clipping HEAD alone
              let working-tree pixels show through wherever HEAD is transparent. */}
            <div
              className="absolute inset-0"
              style={{ clipPath: `inset(0 ${100 - position}% 0 0)` }}
            >
              <img
                src={sides.head.dataUrl}
                alt={`HEAD version of ${relPath}`}
                draggable={false}
                className={head.className}
                style={head.style}
              />
            </div>
            <div className="absolute inset-0" style={{ clipPath: `inset(0 0 0 ${position}%)` }}>
              <img
                src={sides.working.dataUrl}
                alt={`Working tree version of ${relPath}`}
                draggable={false}
                className={working.className}
                style={working.style}
              />
            </div>
            {/* Dual-tone and opaque: a text-primary core between two canvas
              rails, so one of the two holds contrast over any image. Borders,
              not a shadow, because forced colours drop box-shadow. Snapped to
              a whole pixel so the core never smears across two columns. */}
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0 z-10 -ml-px w-[3px] border-x border-surface-canvas bg-text-primary forced-colors:border-[Canvas] forced-colors:bg-[CanvasText]"
              style={{ left: `clamp(1px, ${dividerLeft}, calc(100% - 2px))` }}
            />
            {/* The handle is the slider, so its focus ring is its own and sits on
              the handle rather than on a full-height column. The frame behind
              it takes the drag and the click-to-jump, so the handle only has to
              be findable; the pseudo-element widens its hit area to 24px.
              Colour on the wrapper: forced colours keep an SVG's own colour. */}
            <div
              ref={handleRef}
              role="slider"
              tabIndex={0}
              aria-label="Swipe divider"
              aria-orientation="horizontal"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(position)}
              aria-valuetext={swipeValueText(position)}
              className="absolute top-1/2 z-10 -ml-[7px] -mt-4 flex h-8 w-[15px] cursor-ew-resize items-center justify-center rounded-sm border border-text-secondary bg-surface-panel-elevated text-text-secondary before:absolute before:inset-y-0 before:-inset-x-[5px] before:content-[''] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-primary"
              style={{ left: handleLeft }}
              onKeyDown={(event) => {
                const next = nextSwipePosition(event.key, position);
                if (next === null) return;
                event.preventDefault();
                setPosition(next);
                // At 100% a key can carry the handle past the scrolled view;
                // follow it once it has moved so focus never goes off-screen.
                requestAnimationFrame(() =>
                  handleRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" })
                );
              }}
            >
              <GripVertical className="h-3 w-3" />
            </div>
          </div>
        </div>
        <OverlayChips />
      </div>
      <OverlayFacts sides={sides} dims={dims} />
    </div>
  );
}

function OnionCompare({ sides, dims, relPath, zoom, opacity }: OverlayProps & { opacity: number }) {
  const { frameRef, stageStyle, layerImg } = useOverlayGeometry(dims, zoom);
  const head = layerImg("head");
  const working = layerImg("working");
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className={OVERLAY_FRAME_CLASS}>
        <div ref={frameRef} className={overlayScrollerClass(zoom)}>
          <div style={stageStyle}>
            {/* HEAD as the base layer; the working-tree layer fades in on top. */}
            <img
              src={sides.head.dataUrl}
              alt={`HEAD version of ${relPath}`}
              draggable={false}
              className={head.className}
              style={head.style}
            />
            <img
              src={sides.working.dataUrl}
              alt={`Working tree version of ${relPath}`}
              draggable={false}
              className={working.className}
              style={{ ...working.style, opacity: opacity / 100 }}
            />
          </div>
        </div>
        <OverlayChips />
      </div>
      <OverlayFacts sides={sides} dims={dims} />
    </div>
  );
}

/** Retry only helps a transient read failure; a size or format limit won't change on a refetch. */
function isAggregateReadFailure(result: DiffMediaFileVersions): boolean {
  return (
    !result.head.ok &&
    !result.working.ok &&
    result.head.error === "ERROR" &&
    result.working.error === "ERROR"
  );
}

export function ImageDiffViewer({ relPath, worktreePath, status }: ImageDiffViewerProps) {
  // The last snapshot fully fetched AND off-screen-decoded. It stays painted
  // while the next file loads, so stepping between images never tears down to a
  // skeleton — the previous frame holds until the new one is ready to paint.
  const [committed, setCommitted] = useState<CommittedSnapshot | null>(null);
  // The request key whose read failed. A key, not a boolean: effects run after
  // render, so a boolean would paint the *previous* file's error for one commit
  // on switch. Only a failure keyed to the live target counts.
  const [failedRequestKey, setFailedRequestKey] = useState<string | null>(null);
  const [fetchNonce, setFetchNonce] = useState(0);
  const [mode, setMode] = useState<ImageDiffMode>("two-up");
  const [zoom, setZoom] = useState<ImageZoom>("fit");
  // The fitted scale the panes last measured; 1 means everything already shows
  // at actual size, so the 100% option would change nothing.
  const [fitScale, setFitScale] = useState<number | null>(null);
  const actualIsNoop = fitScale !== null && fitScale >= 1;
  const zoomLevel: ImageZoom = actualIsNoop ? "fit" : zoom;
  const zoomControl: ZoomControl = { level: zoomLevel, onFitScale: setFitScale };
  const zoomOptions = ZOOM_OPTIONS.map((option) =>
    option.value === "actual" ? { ...option, disabled: actualIsNoop } : option
  );
  const scrollSync = useScrollSync();
  const [onionOpacity, setOnionOpacity] = useState(50);
  // Bumped once per fetch; stamped into each snapshot so ImagePane keys are
  // unique per attempt (see CommittedSnapshot.attempt).
  const attemptRef = useRef(0);

  const requestKey = makeRequestKey(worktreePath, relPath, status, fetchNonce);

  // Drop a stale failure the moment the target changes, during render, so
  // returning to a file that previously failed shows a hold/skeleton and the
  // fresh fetch's outcome — not the old error. requestKey repeats per target,
  // so without this a returned-to failure would out-rank a later success that
  // never clears it. (React's "adjust state while rendering" pattern.)
  const [failureTargetKey, setFailureTargetKey] = useState(requestKey);
  if (failureTargetKey !== requestKey) {
    setFailureTargetKey(requestKey);
    setFailedRequestKey(null);
  }

  useEffect(() => {
    let cancelled = false;
    const attempt = (attemptRef.current += 1);
    diffMediaClient
      .readFileVersions({ cwd: worktreePath, filePath: relPath })
      .then(async (result) => {
        if (cancelled) return;
        // A comparison whose two transport reads both failed has nothing to
        // render — surface the aggregate error for this target rather than
        // committing (and then holding) an empty frame. Two *limit* failures
        // (too large, unsupported) commit instead, so each side says why.
        if (deriveSingleSide(status) === null && isAggregateReadFailure(result)) {
          setFailedRequestKey(requestKey);
          return;
        }
        // Warm the decode cache for only the sides this status will show, so
        // the on-screen swap paints instantly. A side that fails to decode is
        // recorded, not fatal — it falls back to the per-side message in
        // two-up rather than blocking the whole swap.
        const decoded = await Promise.all(
          renderableSides(status).map(async (sideKey) => {
            const sideValue = result[sideKey];
            const outcome = sideValue.ok
              ? await decodeOffscreen(sideValue.dataUrl)
              : { ok: true, dims: null };
            return [sideKey, outcome] as const;
          })
        );
        if (cancelled) return;
        const decodeFailures = { head: false, working: false };
        const dims: SideDims = { head: null, working: null };
        for (const [sideKey, outcome] of decoded) {
          if (!outcome.ok) decodeFailures[sideKey] = true;
          dims[sideKey] = outcome.dims;
        }
        setCommitted({
          requestKey,
          attempt,
          versions: result,
          relPath,
          status,
          decodeFailures,
          dims,
        });
      })
      .catch(() => {
        if (!cancelled) setFailedRequestKey(requestKey);
      });
    return () => {
      cancelled = true;
    };
  }, [worktreePath, relPath, status, requestKey]);

  const retry = useCallback(() => setFetchNonce((nonce) => nonce + 1), []);

  // 1. The live target's read failed (transport reject, or a both-sides-failed
  //    comparison): show the aggregate error. Keyed compare, so a stale failure
  //    from a file we've already navigated off never paints here.
  if (failedRequestKey === requestKey) {
    return (
      <div className="flex h-full min-h-0 w-full flex-col items-center justify-center">
        <EmptyState
          className="self-stretch"
          variant="zero-data"
          scale="canvas"
          icon={<ImageOff />}
          title="Couldn't load image versions"
          description="Neither version of this image could be read"
          action={
            <Button variant="contrast" size="sm" onClick={retry}>
              Retry
            </Button>
          }
        />
      </div>
    );
  }

  // 2. Nothing committed yet (first-ever load, or a prior failure with no held
  //    frame to keep): show the skeleton, in the loaded layout's own rows so the
  //    swap doesn't shift anything. Bone count comes from the live status.
  if (committed === null) {
    const skeletonSingle = deriveSingleSide(status);
    const paneBones = (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-1.5">
        <SkeletonBone className="h-[18px] w-20 rounded-sm" />
        <SkeletonBone className="min-h-0 flex-1 rounded-md" />
        <SkeletonBone className="h-4 w-32 rounded-sm" />
      </div>
    );
    return (
      <Skeleton label="Loading image versions" className="flex h-full min-h-0 w-full flex-col">
        {skeletonSingle === null ? (
          <div className="flex shrink-0 px-3 pt-3">
            <SkeletonBone className="h-7 w-52 rounded-lg" />
          </div>
        ) : null}
        <div className="flex min-h-0 flex-1 gap-3 p-3">
          {paneBones}
          {skeletonSingle === null ? paneBones : null}
        </div>
      </Skeleton>
    );
  }

  // 3. Render the committed snapshot. Everything below reads from `committed`,
  //    not live props, so the held frame stays internally consistent (image,
  //    layout, alt text, captions all belong to the same file) until the swap.
  const view = committed;
  // Still holding an earlier file while the live one loads: flag the frame busy
  // for assistive tech. We deliberately do NOT make it `inert` — inerting the
  // focused subtree during a keyboard-driven file step blurs focus out of the
  // dialog (Chromium blurs inert descendants) with nothing to restore it. The
  // only thing inert guarded was a stale Retry firing against the new target,
  // which is harmless — it just refetches the file that's already loading.
  const isHolding = view.requestKey !== requestKey;
  const singleSide = deriveSingleSide(view.status);

  if (singleSide !== null) {
    const caption =
      singleSide === "working" ? "Added — no previous version" : "Deleted — no working version";
    const zoomable = view.dims[singleSide] !== null && !view.decodeFailures[singleSide];
    return (
      <div className="flex h-full min-h-0 w-full flex-col" aria-busy={isHolding || undefined}>
        {zoomable ? (
          <div className="flex shrink-0 px-3 pt-3">
            <SegmentedToggle
              ariaLabel="Zoom"
              options={zoomOptions}
              value={zoomLevel}
              onChange={setZoom}
            />
          </div>
        ) : null}
        <div className={cn(PANE_ROWS_CLASS, "p-3")}>
          <ImagePane
            key={`${view.attempt}:${singleSide}`}
            label={singleSide === "working" ? "Working tree" : "HEAD"}
            side={view.versions[singleSide]}
            relPath={view.relPath}
            caption={caption}
            dims={view.dims[singleSide]}
            fitBox={view.dims[singleSide]}
            zoom={zoomControl}
            initialDecodeFailed={view.decodeFailures[singleSide]}
            onRetry={retry}
          />
        </div>
      </div>
    );
  }

  const okSides: OkSides | null =
    view.versions.head.ok && view.versions.working.ok
      ? { head: view.versions.head, working: view.versions.working }
      : null;
  const bothOk = okSides !== null;
  const anyDecodeFailed = view.decodeFailures.head || view.decodeFailures.working;
  // A broken side can only show its fallback in two-up (swipe/onion <img>s have
  // no error affordance), so a decode failure locks the layout to two-up and
  // hides the compare modes.
  const showModes = bothOk && !anyDecodeFailed;
  const effectiveMode: ImageDiffMode = showModes ? mode : "two-up";
  const headSide = view.versions.head;
  // Actual size only means something once a natural size is known to scale from.
  const zoomable =
    (view.dims.head !== null && view.versions.head.ok && !view.decodeFailures.head) ||
    (view.dims.working !== null && view.versions.working.ok && !view.decodeFailures.working);

  return (
    <div className="flex h-full min-h-0 w-full flex-col" aria-busy={isHolding || undefined}>
      {showModes || zoomable ? (
        // Wraps rather than squeezes: in a narrow pane the opacity control
        // drops to its own row instead of breaking its label over two lines.
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 px-3 pt-3">
          <div className="flex flex-wrap items-center gap-2">
            {showModes ? (
              <SegmentedToggle options={MODE_OPTIONS} value={effectiveMode} onChange={setMode} />
            ) : null}
            {zoomable ? (
              <SegmentedToggle
                ariaLabel="Zoom"
                options={zoomOptions}
                value={zoomLevel}
                onChange={setZoom}
              />
            ) : null}
          </div>
          {effectiveMode === "onion" ? (
            <label className="flex min-w-0 items-center gap-2 whitespace-nowrap text-2xs text-text-secondary">
              Working tree opacity
              <input
                type="range"
                min={0}
                max={100}
                value={onionOpacity}
                aria-label="Working tree opacity"
                aria-valuetext={`Working tree at ${onionOpacity}% over HEAD`}
                onChange={(event) => setOnionOpacity(Number(event.currentTarget.value))}
                className="w-36 min-w-16 shrink cursor-pointer accent-[var(--color-text-primary)]"
              />
              <span className="w-7 text-right font-mono tabular-nums" aria-hidden="true">
                {onionOpacity}%
              </span>
            </label>
          ) : null}
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col p-3">
        {effectiveMode === "two-up" || okSides === null ? (
          <div className={cn(PANE_ROWS_CLASS, "grid-cols-2")}>
            <ImagePane
              key={`${view.attempt}:head`}
              label="HEAD"
              side={headSide}
              relPath={view.relPath}
              dims={view.dims.head}
              fitBox={unionDims(view.dims.head, view.dims.working)}
              zoom={zoomControl}
              scrollSync={scrollSync}
              initialDecodeFailed={view.decodeFailures.head}
              onRetry={retry}
            />
            <ImagePane
              key={`${view.attempt}:working`}
              label="Working tree"
              side={view.versions.working}
              relPath={view.relPath}
              dims={view.dims.working}
              fitBox={unionDims(view.dims.head, view.dims.working)}
              zoom={zoomControl}
              scrollSync={scrollSync}
              baseline={headSide.ok ? { side: headSide, dims: view.dims.head } : undefined}
              initialDecodeFailed={view.decodeFailures.working}
              onRetry={retry}
            />
          </div>
        ) : effectiveMode === "swipe" ? (
          <SwipeCompare
            sides={okSides}
            dims={view.dims}
            relPath={view.relPath}
            zoom={zoomControl}
          />
        ) : (
          <OnionCompare
            sides={okSides}
            dims={view.dims}
            relPath={view.relPath}
            zoom={zoomControl}
            opacity={onionOpacity}
          />
        )}
      </div>
    </div>
  );
}
