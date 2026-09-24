import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, ImageOff, RotateCw } from "lucide-react";
import { AppDialog } from "@/components/ui/AppDialog";
import { Button } from "@/components/ui/button";
import { Skeleton, SkeletonBone } from "@/components/ui/Skeleton";
import { cn } from "@/lib/utils";
import type { HelpFigure } from "@/store/helpPanelStore";

interface FigureLightboxProps {
  figures: HelpFigure[];
  /** The figureNumber currently expanded, or null when the lightbox is closed. */
  selectedFigureNumber: number | null;
  onClose: () => void;
  /** Select a different figure by its figureNumber (drives prev/next navigation). */
  onSelectFigure: (figureNumber: number) => void;
}

type LoadStatus = "pending" | "loaded" | "failed";

/**
 * Full-size view of a single documentation figure surfaced via `help.displayImage`
 * (#9829). Wraps {@link AppDialog} so it inherits the app-wide escape stack, focus
 * trap, and focus restoration — a native `<dialog>` would double-handle Escape and
 * close the host HelpPanel underneath. ArrowLeft/ArrowRight step between figures,
 * clamped at the ends (no wraparound); Home/End jump to either end. The attribution
 * frame (source label, caption) renders outside the `<img>` so a doc image can never
 * masquerade as Daintree's own UI.
 *
 * The stage has a fixed height and the chevrons sit in gutters beside it, so the
 * controls stay put from one figure to the next and never cover the image.
 */
export function FigureLightbox({
  figures,
  selectedFigureNumber,
  onClose,
  onSelectFigure,
}: FigureLightboxProps) {
  const selectedIndex =
    selectedFigureNumber === null
      ? -1
      : figures.findIndex((f) => f.figureNumber === selectedFigureNumber);
  const selectedFigure = selectedIndex === -1 ? undefined : figures[selectedIndex];
  const isOpen = selectedFigure !== undefined;

  // AppDialog stays mounted and is driven by `isOpen`, like every other dialog in
  // the app: mounting it already-open skips the frame its initial focus waits on,
  // leaving focus on the thumbnail behind the modal, and unmounting it on close
  // cuts the exit animation. The last figure shown keeps rendering while it exits.
  const [lastFigure, setLastFigure] = useState<HelpFigure | undefined>(undefined);
  if (selectedFigure && selectedFigure !== lastFigure) setLastFigure(selectedFigure);
  const figure = selectedFigure ?? lastFigure;

  // Load state is keyed to the image instance it describes rather than reset by
  // an effect, so a cached image that loads before the effect runs can't be
  // knocked back to pending by it.
  const [retryNonce, setRetryNonce] = useState(0);
  const imageKey = figure ? `${figure.imageId}:${retryNonce}` : "";
  const [load, setLoad] = useState<{ key: string; status: LoadStatus }>({
    key: "",
    status: "pending",
  });
  const status: LoadStatus = load.key === imageKey ? load.status : "pending";

  // Actual size is per figure: stepping to another one goes back to fit.
  const [actualSizeImageId, setActualSizeImageId] = useState<string | null>(null);
  const isActualSize = figure !== undefined && actualSizeImageId === figure.imageId;

  const hasPrev = selectedIndex > 0;
  const hasNext = selectedIndex !== -1 && selectedIndex < figures.length - 1;

  const goTo = (index: number) => {
    const target = figures[index];
    if (target && index !== selectedIndex) onSelectFigure(target.figureNumber);
  };

  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.isComposing || e.repeat) return;
      let index: number | null = null;
      if (e.key === "ArrowLeft" && hasPrev) index = selectedIndex - 1;
      else if (e.key === "ArrowRight" && hasNext) index = selectedIndex + 1;
      else if (e.key === "Home" && hasPrev) index = 0;
      else if (e.key === "End" && hasNext) index = figures.length - 1;
      if (index === null) return;
      e.preventDefault();
      onSelectFigure(figures[index]!.figureNumber);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isOpen, hasPrev, hasNext, selectedIndex, figures, onSelectFigure]);

  // Warm the neighbours so stepping doesn't flash an empty stage.
  useEffect(() => {
    if (selectedIndex === -1) return;
    for (const neighbour of [figures[selectedIndex - 1], figures[selectedIndex + 1]]) {
      if (!neighbour) continue;
      const img = new Image();
      img.referrerPolicy = "no-referrer";
      img.src = neighbour.url;
    }
  }, [selectedIndex, figures]);

  if (!figure) return null;

  const position = isOpen ? selectedIndex + 1 : figures.indexOf(figure) + 1;
  const toggleActualSize = () => setActualSizeImageId(isActualSize ? null : figure.imageId);

  return (
    <AppDialog
      isOpen={isOpen}
      onClose={onClose}
      size="5xl"
      maxHeight="max-h-[92vh]"
      data-testid="figure-lightbox"
    >
      <AppDialog.Header>
        <div className="flex min-w-0 items-baseline gap-2">
          <AppDialog.Title>Figure {figure.figureNumber}</AppDialog.Title>
          <span className="shrink-0 text-xs tabular-nums text-text-secondary">
            {position} of {figures.length}
          </span>
        </div>
        <AppDialog.CloseButton />
      </AppDialog.Header>
      {/* Resolves AppDialog's always-on aria-describedby to a real element. Kept
          generic (not the caption, which is announced via the visible frame and
          the live region) so it doesn't double-read. */}
      <AppDialog.Description className="sr-only">
        Documentation figure {figure.figureNumber} from Daintree docs
      </AppDialog.Description>
      <AppDialog.BodyScroll className="flex flex-col">
        <figure className="m-0 flex flex-col gap-3">
          <div className="flex h-[min(64vh,680px)] items-center gap-2">
            <StepButton
              direction="previous"
              available={hasPrev}
              onStep={() => goTo(selectedIndex - 1)}
            />
            <div
              className={cn(
                "relative h-full min-w-0 flex-1 rounded-[var(--radius-md)] bg-overlay-subtle",
                isActualSize ? "overflow-auto" : "overflow-hidden"
              )}
              data-testid="figure-lightbox-stage"
            >
              {status === "failed" ? (
                <div
                  className="flex h-full flex-col items-center justify-center gap-3 text-text-secondary"
                  role="status"
                >
                  <ImageOff className="w-8 h-8" aria-hidden="true" />
                  <p className="text-sm">Couldn't load figure {figure.figureNumber}</p>
                  <Button variant="subtle" size="sm" onClick={() => setRetryNonce((n) => n + 1)}>
                    <RotateCw aria-hidden="true" />
                    Retry
                  </Button>
                </div>
              ) : (
                <div
                  className={cn(
                    "flex items-center justify-center",
                    isActualSize ? "h-max min-h-full w-max min-w-full" : "h-full w-full"
                  )}
                >
                  {/* Clicking the image is the pointer path to actual size; the
                      toggle below the stage is the keyboard one, so the image
                      itself stays out of the tab order. */}
                  <img
                    key={imageKey}
                    src={figure.url}
                    alt={figure.altText ?? `Figure ${figure.figureNumber}`}
                    referrerPolicy="no-referrer"
                    onLoad={() => setLoad({ key: imageKey, status: "loaded" })}
                    onError={() => setLoad({ key: imageKey, status: "failed" })}
                    onClick={status === "loaded" ? toggleActualSize : undefined}
                    className={cn(
                      "transition-opacity duration-150",
                      isActualSize
                        ? "max-w-none cursor-zoom-out"
                        : "max-h-full max-w-full object-contain cursor-zoom-in",
                      status === "loaded" ? "opacity-100" : "opacity-0"
                    )}
                  />
                </div>
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
            </div>
            <StepButton
              direction="next"
              available={hasNext}
              onStep={() => goTo(selectedIndex + 1)}
            />
          </div>

          {/* Attribution frame — kept outside the <img> so a documentation image
              can't pass as Daintree's own UI. A caption of up to two lines fits
              without moving anything; a longer one scrolls in place. */}
          <figcaption className="flex min-h-[3.25rem] items-start gap-4 border-t border-border-default pt-3">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              {figure.caption && (
                <p className="max-h-16 overflow-y-auto text-sm text-text-primary select-text">
                  {figure.caption}
                </p>
              )}
              <p className="text-2xs text-text-secondary">{figure.figureLabel} · Daintree docs</p>
            </div>
            <Button
              variant="ghost"
              size="xs"
              aria-pressed={isActualSize}
              aria-disabled={status !== "loaded" || undefined}
              onClick={() => {
                if (status === "loaded") toggleActualSize();
              }}
              className="shrink-0 aria-pressed:bg-overlay-selected aria-pressed:text-text-primary aria-disabled:opacity-50 aria-disabled:cursor-not-allowed"
            >
              Actual size
            </Button>
          </figcaption>
        </figure>

        {/* Local live region — VoiceOver drops aria-live updates made from
            outside the focused aria-modal (#9434), so it must sit inside the
            dialog body, not in the host panel. */}
        <span className="sr-only" aria-live="polite" aria-atomic="true">
          Figure {figure.figureNumber}, {position} of {figures.length}
        </span>
      </AppDialog.BodyScroll>
    </AppDialog>
  );
}

interface StepButtonProps {
  direction: "previous" | "next";
  available: boolean;
  onStep: () => void;
}

/**
 * Always rendered, even at the ends: removing the button that holds focus when
 * the last step lands would drop focus out of the dialog's tab sequence. At the
 * ends it announces itself unavailable and ignores activation instead.
 */
function StepButton({ direction, available, onStep }: StepButtonProps) {
  const Icon = direction === "previous" ? ChevronLeft : ChevronRight;
  return (
    <Button
      variant="subtle"
      size="icon"
      aria-label={direction === "previous" ? "Previous figure" : "Next figure"}
      aria-disabled={!available || undefined}
      onClick={() => {
        if (available) onStep();
      }}
      className="shrink-0 rounded-full aria-disabled:opacity-40 aria-disabled:cursor-not-allowed"
    >
      <Icon aria-hidden="true" />
    </Button>
  );
}
