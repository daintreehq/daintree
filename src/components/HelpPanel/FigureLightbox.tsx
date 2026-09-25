import { useEffect, useRef, useState, type Ref } from "react";
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
  /** Where focus goes on close, in preference to the thumbnail that opened it. */
  restoreFocusTo?: () => HTMLElement | null;
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
  restoreFocusTo,
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

  // Actual size belongs to the figure on screen: any change of figure — a step,
  // or the rail opening another — goes back to fit.
  const [isActualSize, setIsActualSize] = useState(false);
  const [sizedImageId, setSizedImageId] = useState(figure?.imageId);
  if (figure && figure.imageId !== sizedImageId) {
    setSizedImageId(figure.imageId);
    setIsActualSize(false);
  }

  const stageRef = useRef<HTMLDivElement>(null);
  // The dialog surface mounts a render after it opens, so an effect keyed only
  // on the caption would measure before the element exists and never again —
  // the callback ref below also bumps this to re-run it once the node is there.
  const captionRef = useRef<HTMLParagraphElement | null>(null);
  const [captionMounted, setCaptionMounted] = useState(false);
  const attachCaption = (node: HTMLParagraphElement | null) => {
    captionRef.current = node;
    setCaptionMounted(node !== null);
  };
  const [captionScroll, setCaptionScroll] = useState({ overflows: false, atEnd: true });

  // A caption longer than its two-line box scrolls in place; fade its bottom
  // edge while there is more below, and make it a focusable region so the
  // keyboard can read the rest.
  const caption = figure?.caption;
  useEffect(() => {
    const el = captionRef.current;
    if (!el) {
      setCaptionScroll({ overflows: false, atEnd: true });
      return;
    }
    const measure = () => {
      const overflows = el.scrollHeight > el.clientHeight + 1;
      const atEnd = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
      setCaptionScroll((prev) =>
        prev.overflows === overflows && prev.atEnd === atEnd ? prev : { overflows, atEnd }
      );
    };
    el.scrollTop = 0;
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => {
      el.removeEventListener("scroll", measure);
      observer.disconnect();
    };
  }, [caption, captionMounted]);

  const hasPrev = selectedIndex > 0;
  const hasNext = selectedIndex !== -1 && selectedIndex < figures.length - 1;

  const previousButtonRef = useRef<HTMLButtonElement>(null);
  const nextButtonRef = useRef<HTMLButtonElement>(null);

  // Stepping swaps the stage and caption content; if focus is on something that
  // swap removes (the stage's Retry, an overflowing caption), move it to the
  // step button in the direction of travel first so it stays in the dialog.
  const goTo = (index: number) => {
    const target = figures[index];
    if (!target || index === selectedIndex) return;
    const active = document.activeElement;
    const inSwappedContent =
      active instanceof Node &&
      active !== stageRef.current &&
      (stageRef.current?.contains(active) || captionRef.current?.contains(active));
    if (inSwappedContent) {
      const toward = index < selectedIndex ? previousButtonRef : nextButtonRef;
      toward.current?.focus({ preventScroll: true });
    }
    onSelectFigure(target.figureNumber);
  };
  // The window key handler below reads the latest `goTo` through this ref
  // rather than re-subscribing on every render.
  const goToRef = useRef(goTo);
  useEffect(() => {
    goToRef.current = goTo;
  });

  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.isComposing || e.repeat || e.defaultPrevented) return;
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      // Scroll regions keep their own keys: an enlarged figure's stage scrolls
      // with all of them, a long caption with Home/End.
      if (e.target instanceof Node) {
        if (isActualSize && stageRef.current?.contains(e.target)) return;
        if ((e.key === "Home" || e.key === "End") && captionRef.current?.contains(e.target)) {
          return;
        }
      }
      let index: number | null = null;
      if (e.key === "ArrowLeft" && hasPrev) index = selectedIndex - 1;
      else if (e.key === "ArrowRight" && hasNext) index = selectedIndex + 1;
      else if (e.key === "Home" && hasPrev) index = 0;
      else if (e.key === "End" && hasNext) index = figures.length - 1;
      if (index === null) return;
      e.preventDefault();
      goToRef.current(index);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isOpen, hasPrev, hasNext, selectedIndex, figures, isActualSize]);

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
  const toggleActualSize = () => setIsActualSize((on) => !on);

  return (
    <AppDialog
      isOpen={isOpen}
      onClose={onClose}
      size="5xl"
      maxHeight="max-h-[92vh]"
      restoreFocusTo={restoreFocusTo}
      preferRestoreFocusTo
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
              ref={previousButtonRef}
              direction="previous"
              available={hasPrev}
              onStep={() => goTo(selectedIndex - 1)}
            />
            {/* Focusable at actual size so the keyboard can scroll it; always a
                programmatic focus target so Retry has somewhere to hand focus. */}
            <div
              ref={stageRef}
              tabIndex={isActualSize ? 0 : -1}
              role={isActualSize ? "region" : undefined}
              aria-label={isActualSize ? `Figure ${figure.figureNumber} at actual size` : undefined}
              className={cn(
                "relative h-full min-w-0 flex-1 rounded-[var(--radius-md)] bg-overlay-subtle focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary",
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
                  <Button
                    variant="subtle"
                    size="sm"
                    onClick={() => {
                      setRetryNonce((n) => n + 1);
                      // Retry unmounts itself; keep focus inside the dialog.
                      stageRef.current?.focus({ preventScroll: true });
                    }}
                  >
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
              ref={nextButtonRef}
              direction="next"
              available={hasNext}
              onStep={() => goTo(selectedIndex + 1)}
            />
          </div>

          {/* Attribution frame — kept outside the <img> so a documentation image
              can't pass as Daintree's own UI. Fixed height: two caption lines fit,
              a longer caption scrolls in place, so the dialog — and the step
              buttons in it — never resize from one figure to the next. */}
          <figcaption className="flex h-19 items-start gap-4 border-t border-border-default pt-3">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              {figure.caption && (
                <p
                  ref={attachCaption}
                  tabIndex={captionScroll.overflows ? 0 : undefined}
                  role={captionScroll.overflows ? "region" : undefined}
                  aria-label={captionScroll.overflows ? "Figure caption" : undefined}
                  className="max-h-10 overflow-y-auto rounded-[var(--radius-sm)] text-sm text-text-primary select-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary"
                  style={
                    captionScroll.overflows && !captionScroll.atEnd
                      ? {
                          maskImage: "linear-gradient(to bottom, black 55%, transparent)",
                          WebkitMaskImage: "linear-gradient(to bottom, black 55%, transparent)",
                        }
                      : undefined
                  }
                >
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
  ref: Ref<HTMLButtonElement>;
  direction: "previous" | "next";
  available: boolean;
  onStep: () => void;
}

/**
 * Always rendered, even at the ends: removing the button that holds focus when
 * the last step lands would drop focus out of the dialog's tab sequence. At the
 * ends it announces itself unavailable and ignores activation instead, and takes
 * no pointer events so its hover state can't suggest otherwise — keyboard focus
 * is unaffected.
 */
function StepButton({ ref, direction, available, onStep }: StepButtonProps) {
  const Icon = direction === "previous" ? ChevronLeft : ChevronRight;
  return (
    <Button
      ref={ref}
      variant="subtle"
      size="icon"
      aria-label={direction === "previous" ? "Previous figure" : "Next figure"}
      aria-disabled={!available || undefined}
      onClick={() => {
        if (available) onStep();
      }}
      className="shrink-0 rounded-full aria-disabled:opacity-40 aria-disabled:pointer-events-none"
    >
      <Icon aria-hidden="true" />
    </Button>
  );
}
