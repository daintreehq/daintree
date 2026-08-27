import { useEffect, useRef, useState } from "react";
import { ImageOff, RotateCw } from "lucide-react";
import { Skeleton, SkeletonBone } from "@/components/ui/Skeleton";
import { cn } from "@/lib/utils";
import type { HelpFigure } from "@/store/helpPanelStore";
import { FigureLightbox } from "./FigureLightbox";

/**
 * Fixed-height strip of thumbnails for the documentation figures the assistant
 * surfaced via `help.displayImage` (#9829). Sits between the terminal and the
 * bottom info bar. The height is intentionally fixed — a growing rail would
 * re-trigger xterm's fit/resize on every figure. Figures accumulate for the
 * session (no per-image dismissal, so inline `[image #N]` references never go
 * dead) and clear on teardown via the store. Clicking a thumbnail expands it in
 * {@link FigureLightbox}.
 */
export function FigureRail({ figures }: { figures: HelpFigure[] }) {
  const [selectedFigureNumber, setSelectedFigureNumber] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const figureCount = figures.length;

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

  if (figureCount === 0) return null;

  const newestFigureNumber = figures.reduce((max, f) => Math.max(max, f.figureNumber), -Infinity);

  return (
    <div
      className="shrink-0 h-[88px] overflow-hidden border-t border-border-default"
      data-testid="figure-rail"
    >
      <div
        ref={scrollRef}
        className="flex flex-row items-center gap-2 h-full overflow-x-auto overflow-y-hidden px-2 scrollbar-none"
      >
        {figures.map((figure) => (
          <FigureThumbnail
            key={figure.imageId}
            figure={figure}
            isNewest={figure.figureNumber === newestFigureNumber}
            onClick={() => setSelectedFigureNumber(figure.figureNumber)}
          />
        ))}
      </div>
      <FigureLightbox
        figures={figures}
        selectedFigureNumber={selectedFigureNumber}
        onClose={() => setSelectedFigureNumber(null)}
        onSelectFigure={setSelectedFigureNumber}
      />
    </div>
  );
}

interface FigureThumbnailProps {
  figure: HelpFigure;
  isNewest: boolean;
  onClick: () => void;
}

function FigureThumbnail({ figure, isNewest, onClick }: FigureThumbnailProps) {
  const [status, setStatus] = useState<"pending" | "loaded" | "failed">("pending");
  // Bumping the nonce remounts the <img> to fire a fresh request on retry.
  const [retryNonce, setRetryNonce] = useState(0);

  const handleRetry = () => {
    setStatus("pending");
    setRetryNonce((n) => n + 1);
  };

  return (
    <div
      className={cn(
        "relative shrink-0 h-[72px] w-[104px] rounded-[var(--radius-md)] overflow-hidden border border-border-default bg-overlay-subtle",
        isNewest && "animate-figure-arrive"
      )}
      data-testid="figure-thumbnail"
    >
      {status === "failed" ? (
        <div className="flex h-full w-full flex-col items-center justify-center gap-1 text-daintree-text/50">
          <ImageOff className="w-4 h-4" aria-hidden="true" />
          <button
            type="button"
            onClick={handleRetry}
            aria-label={`Retry figure ${figure.figureNumber}`}
            className="flex items-center gap-1 text-3xs text-daintree-text/60 hover:text-text-primary transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary rounded"
          >
            <RotateCw className="w-2.5 h-2.5" aria-hidden="true" />
            Retry
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={onClick}
          aria-label={
            figure.caption
              ? `Figure ${figure.figureNumber}: ${figure.caption}`
              : `Figure ${figure.figureNumber}`
          }
          className="block h-full w-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:-outline-offset-2"
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
            onError={() => setStatus("failed")}
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

      {status === "loaded" && (
        <span className="pointer-events-none absolute bottom-0 left-0 right-0 bg-scrim-medium px-1.5 py-0.5 text-3xs font-medium text-daintree-text/90">
          {figure.figureLabel}
        </span>
      )}
    </div>
  );
}
