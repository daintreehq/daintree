import { useEffect, useRef, useState, type CSSProperties } from "react";
import { ImageOff, RotateCw } from "lucide-react";
import { Skeleton, SkeletonBone } from "@/components/ui/Skeleton";
import { useHorizontalScrollControls } from "@/hooks/useHorizontalScrollControls";
import { cn } from "@/lib/utils";
import type { HelpFigure, HelpFigureRequest } from "@/store/helpPanelStore";
import { FigureLightbox } from "./FigureLightbox";

interface FigureRailProps {
  figures: HelpFigure[];
  /** The figure an `[image #N]` reference or the lightbox last made current. */
  activeFigureNumber?: number | null;
  /** A pending `[image #N]` activation to reveal (and open, when asked). */
  figureRequest?: HelpFigureRequest;
  onActivateFigure?: (figureNumber: number) => void;
  onFigureRequestHandled?: () => void;
}

/**
 * Fixed-height strip of thumbnails for the documentation figures the assistant
 * surfaced via `help.displayImage` (#9829). Sits between the terminal and the
 * bottom info bar. The height is intentionally fixed — a growing rail would
 * re-trigger xterm's fit/resize on every figure. Figures accumulate for the
 * session (no per-image dismissal, so inline `[image #N]` references never go
 * dead) and clear on teardown via the store. Clicking a thumbnail expands it in
 * {@link FigureLightbox}.
 *
 * One thumbnail is always marked current: the figure an `[image #N]` click or
 * the lightbox last picked, otherwise the newest — the one the assistant is
 * talking about. The marker is a neutral outline so it survives forced colors
 * and never competes with the accent focus ring.
 */
export function FigureRail({
  figures,
  activeFigureNumber = null,
  figureRequest,
  onActivateFigure,
  onFigureRequestHandled,
}: FigureRailProps) {
  const [selectedFigureNumber, setSelectedFigureNumber] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastViewedRef = useRef<number | null>(null);
  // Fade whichever end has figures scrolled out of view — the scrollbar is
  // hidden to keep the rail at its fixed height, so this is the only sign.
  // `scroll-px-6` on the scroller matches the fade width, so a thumbnail
  // revealed by focus or by a reference lands clear of it.
  const { canScrollLeft, canScrollRight } = useHorizontalScrollControls(scrollRef);
  const figureCount = figures.length;

  const newestFigureNumber = figures.reduce((max, f) => Math.max(max, f.figureNumber), -Infinity);
  const currentFigureNumber =
    activeFigureNumber !== null && figures.some((f) => f.figureNumber === activeFigureNumber)
      ? activeFigureNumber
      : newestFigureNumber;

  // Keep the newest figure in view as it arrives. Only reacts to the count so a
  // user who scrolled back isn't yanked on unrelated re-renders.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [figureCount]);

  // Close the lightbox if the figure it's showing disappears (session reset or
  // future memory-pressure eviction, #9830) so stale selection can't reopen it.
  useEffect(() => {
    if (
      selectedFigureNumber !== null &&
      !figures.some((f) => f.figureNumber === selectedFigureNumber)
    ) {
      setSelectedFigureNumber(null);
    }
  }, [figures, selectedFigureNumber]);

  // Act on an `[image #N]` click: bring its thumbnail into view, and open it
  // when the click asked for that. Cleared once handled so switching lanes
  // can't replay it. The scroll is idempotent and runs on every pass while the
  // request is pending, so it still wins when the scroll-to-newest effect above
  // re-runs after it (StrictMode's remount does exactly that); opening happens
  // once per request.
  const handledRequestRef = useRef<HelpFigureRequest | null>(null);
  useEffect(() => {
    if (!figureRequest) return;
    const { figureNumber, open } = figureRequest;
    const known = figures.some((f) => f.figureNumber === figureNumber);
    if (known) {
      scrollRef.current
        ?.querySelector(`[data-figure-number="${figureNumber}"]`)
        ?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
    if (handledRequestRef.current === figureRequest) return;
    handledRequestRef.current = figureRequest;
    if (known && open) {
      setSelectedFigureNumber(figureNumber);
      lastViewedRef.current = figureNumber;
    }
    onFigureRequestHandled?.();
  }, [figureRequest, figures, onFigureRequestHandled]);

  if (figureCount === 0) return null;

  const selectFigure = (figureNumber: number) => {
    setSelectedFigureNumber(figureNumber);
    lastViewedRef.current = figureNumber;
    onActivateFigure?.(figureNumber);
  };

  // After stepping in the lightbox, closing returns the user to the figure they
  // were last looking at — focusing its thumbnail also scrolls it into view —
  // rather than to the one they opened.
  const resolveLastViewedThumbnail = () => {
    const figureNumber = lastViewedRef.current;
    if (figureNumber === null) return null;
    return (
      scrollRef.current?.querySelector<HTMLElement>(
        `[data-figure-number="${figureNumber}"] button`
      ) ?? null
    );
  };

  return (
    <div
      className="shrink-0 h-[88px] overflow-hidden border-t border-border-default"
      data-testid="figure-rail"
    >
      <div
        ref={scrollRef}
        role="list"
        aria-label="Figures"
        className="flex flex-row items-center gap-2 h-full overflow-x-auto overflow-y-hidden px-2 scroll-px-6 scrollbar-none"
        style={edgeMask(canScrollLeft, canScrollRight)}
        // Chromium leaves a partly visible element where it is on focus, which
        // here means half under an edge fade; bring a focused thumbnail fully
        // in, clear of the fade (`scroll-px-6`).
        onFocus={(e) => {
          if (e.target instanceof HTMLElement) {
            e.target
              .closest("[data-figure-number]")
              ?.scrollIntoView({ block: "nearest", inline: "nearest" });
          }
        }}
      >
        {figures.map((figure) => (
          <FigureThumbnail
            key={figure.imageId}
            figure={figure}
            isNewest={figure.figureNumber === newestFigureNumber}
            isCurrent={figure.figureNumber === currentFigureNumber}
            onClick={() => selectFigure(figure.figureNumber)}
          />
        ))}
      </div>
      <FigureLightbox
        figures={figures}
        selectedFigureNumber={selectedFigureNumber}
        onClose={() => setSelectedFigureNumber(null)}
        onSelectFigure={selectFigure}
        restoreFocusTo={resolveLastViewedThumbnail}
      />
    </div>
  );
}

const EDGE_FADE = "24px";

function edgeMask(fadeStart: boolean, fadeEnd: boolean): CSSProperties | undefined {
  if (!fadeStart && !fadeEnd) return undefined;
  const start = fadeStart ? `transparent 0, black ${EDGE_FADE}` : "black 0";
  const end = fadeEnd ? `black calc(100% - ${EDGE_FADE}), transparent 100%` : "black 100%";
  const mask = `linear-gradient(to right, ${start}, ${end})`;
  return { maskImage: mask, WebkitMaskImage: mask };
}

interface FigureThumbnailProps {
  figure: HelpFigure;
  isNewest: boolean;
  isCurrent: boolean;
  onClick: () => void;
}

function FigureThumbnail({ figure, isNewest, isCurrent, onClick }: FigureThumbnailProps) {
  const [status, setStatus] = useState<"pending" | "loaded" | "failed">("pending");
  // Bumping the nonce remounts the <img> to fire a fresh request on retry.
  const [retryNonce, setRetryNonce] = useState(0);
  const openButtonRef = useRef<HTMLButtonElement>(null);
  const retryButtonRef = useRef<HTMLButtonElement>(null);
  const [focusAfterRetry, setFocusAfterRetry] = useState(false);
  const [focusRetryAfterFailure, setFocusRetryAfterFailure] = useState(false);

  // A failure unmounts the thumbnail button; if that button held focus, hand it
  // to the Retry that replaces it. A failure elsewhere never moves focus.
  const handleError = () => {
    if (document.activeElement === openButtonRef.current) setFocusRetryAfterFailure(true);
    setStatus("failed");
  };

  useEffect(() => {
    if (!focusRetryAfterFailure || status !== "failed") return;
    retryButtonRef.current?.focus({ preventScroll: true });
    setFocusRetryAfterFailure(false);
  }, [focusRetryAfterFailure, status]);

  const handleRetry = () => {
    setStatus("pending");
    setRetryNonce((n) => n + 1);
    // Retry unmounts itself, so hand focus to the thumbnail that replaces it
    // rather than letting it fall out of the rail.
    setFocusAfterRetry(true);
  };

  useEffect(() => {
    if (!focusAfterRetry || status === "failed") return;
    openButtonRef.current?.focus({ preventScroll: true });
    setFocusAfterRetry(false);
  }, [focusAfterRetry, status]);

  return (
    <div
      role="listitem"
      aria-current={isCurrent ? "true" : undefined}
      className={cn(
        "relative shrink-0 h-[72px] w-[104px] rounded-[var(--radius-md)] overflow-hidden border bg-overlay-subtle transition-[border-color] duration-150",
        status === "loaded"
          ? "border-border-default hover:border-border-strong"
          : "border-border-strong",
        // Both rings sit outside the tile, against the rail, so neither depends
        // on the image under it: neutral for current, accent (taking over the
        // same outline) while the thumbnail's button has keyboard focus.
        isCurrent && "outline-2 outline-offset-1 outline-text-secondary",
        "has-[[data-thumbnail-open]:focus-visible]:outline-2 has-[[data-thumbnail-open]:focus-visible]:outline-offset-1 has-[[data-thumbnail-open]:focus-visible]:outline-accent-primary",
        isNewest && "animate-figure-arrive"
      )}
      data-testid="figure-thumbnail"
      data-figure-number={figure.figureNumber}
    >
      {status === "failed" ? (
        <div className="flex h-full w-full flex-col items-center justify-center gap-1 pb-4 text-text-secondary">
          <ImageOff className="w-4 h-4" aria-hidden="true" />
          <button
            ref={retryButtonRef}
            type="button"
            onClick={handleRetry}
            aria-label={`Retry figure ${figure.figureNumber}`}
            className="flex items-center gap-1 px-1.5 py-0.5 text-3xs text-text-secondary hover:text-text-primary transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary rounded-[var(--radius-sm)]"
          >
            <RotateCw className="w-2.5 h-2.5" aria-hidden="true" />
            Retry
          </button>
        </div>
      ) : (
        <button
          ref={openButtonRef}
          type="button"
          onClick={onClick}
          aria-label={
            figure.caption
              ? `Figure ${figure.figureNumber}: ${figure.caption}`
              : `Figure ${figure.figureNumber}`
          }
          data-thumbnail-open=""
          // The inset offset does nothing while the outline is hidden; it is the
          // hook forced-colors mode's global Highlight ring keys off to draw
          // inside this button, where the tile's overflow can't clip it.
          // eslint-disable-next-line component-contract/no-unpaired-outline-suppression -- the tile paints this button's focus ring outside the image (has-[[data-thumbnail-open]:focus-visible])
          className="block h-full w-full focus-visible:outline-hidden focus-visible:-outline-offset-2"
        >
          {/* Animated WebP demo loops play natively through the browser image
              decoder — no decoding hint or poster-swap is needed, and rail
              thumbnails are intentionally allowed to loop (source is the
              URL-validated daintree.org host). Note: prefers-reduced-motion does
              not pause native animated images in Chromium 148 — the CSS
              `image-animation` property is not yet shipped — so the reduce-motion
              variant in index.css (which targets CSS @keyframes) has no effect
              here. A still-frame fallback would need a server-supplied poster
              URL; tracked as a separate enhancement. */}
          <img
            key={retryNonce}
            src={figure.url}
            alt={figure.altText ?? `Figure ${figure.figureNumber}`}
            referrerPolicy="no-referrer"
            onLoad={() => setStatus("loaded")}
            onError={handleError}
            className={cn(
              "h-full w-full object-cover transition-opacity duration-150",
              status === "loaded" ? "opacity-100" : "opacity-0"
            )}
          />
        </button>
      )}

      {status === "pending" && (
        <Skeleton
          inert
          className="absolute inset-0"
          label={`Loading figure ${figure.figureNumber}`}
        >
          <SkeletonBone className="h-full w-full rounded-none" />
        </Skeleton>
      )}

      {/* On an opaque chip rather than a scrim so it reads the same over any
          image and in every theme, and in every state — a figure that is still
          loading or failed still has to be matchable to its `[image #N]`. */}
      <span
        className="pointer-events-none absolute bottom-1 left-1 rounded-[var(--radius-sm)] border border-border-subtle bg-surface-panel-elevated px-1 text-3xs font-medium leading-4 text-text-primary"
        aria-hidden="true"
      >
        {figure.figureLabel}
      </span>
    </div>
  );
}
