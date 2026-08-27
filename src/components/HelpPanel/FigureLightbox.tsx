import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, ImageOff } from "lucide-react";
import { AppDialog } from "@/components/ui/AppDialog";
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

/**
 * Full-size view of a single documentation figure surfaced via `help.displayImage`
 * (#9829). Wraps {@link AppDialog} so it inherits the app-wide escape stack, focus
 * trap, and focus restoration — a native `<dialog>` would double-handle Escape and
 * close the host HelpPanel underneath. ArrowLeft/ArrowRight step between figures,
 * clamped at the ends (no wraparound). The attribution frame (figure number, source
 * label, caption) renders outside the `<img>` so a doc image can never masquerade as
 * Daintree's own UI.
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
  const figure = selectedIndex === -1 ? undefined : figures[selectedIndex];
  const isOpen = figure !== undefined;

  // Reset the load state whenever the expanded figure changes — keying the
  // `<img>` on `imageId` remounts it, so a fresh request fires per figure.
  const [status, setStatus] = useState<"pending" | "loaded" | "failed">("pending");
  useEffect(() => {
    setStatus("pending");
  }, [figure?.imageId]);

  const hasPrev = selectedIndex > 0;
  const hasNext = selectedIndex !== -1 && selectedIndex < figures.length - 1;

  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.isComposing || e.repeat) return;
      if (e.key === "ArrowLeft" && hasPrev) {
        e.preventDefault();
        onSelectFigure(figures[selectedIndex - 1]!.figureNumber);
      } else if (e.key === "ArrowRight" && hasNext) {
        e.preventDefault();
        onSelectFigure(figures[selectedIndex + 1]!.figureNumber);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isOpen, hasPrev, hasNext, selectedIndex, figures, onSelectFigure]);

  if (!figure) return null;

  return (
    <AppDialog
      isOpen={isOpen}
      onClose={onClose}
      size="5xl"
      maxHeight="max-h-[90vh]"
      data-testid="figure-lightbox"
    >
      <AppDialog.Header plainBody>
        <AppDialog.Title>Figure {figure.figureNumber}</AppDialog.Title>
        <AppDialog.CloseButton />
      </AppDialog.Header>
      {/* Resolves AppDialog's always-on aria-describedby to a real element. Kept
          generic (not the caption, which is announced via the visible frame and
          the live region) so it doesn't double-read. */}
      <AppDialog.Description className="sr-only">
        Documentation figure {figure.figureNumber} from Daintree docs
      </AppDialog.Description>
      <AppDialog.BodyScroll className="flex flex-col gap-4">
        <div className="relative flex items-center justify-center bg-overlay-subtle rounded-[var(--radius-md)] min-h-[200px] overflow-hidden">
          {status === "failed" ? (
            <div className="flex flex-col items-center gap-2 py-12 text-daintree-text/50">
              <ImageOff className="w-8 h-8" aria-hidden="true" />
              <p className="text-sm">Couldn't load figure {figure.figureNumber}</p>
            </div>
          ) : (
            <img
              key={figure.imageId}
              src={figure.url}
              alt={figure.altText ?? `Figure ${figure.figureNumber}`}
              referrerPolicy="no-referrer"
              onLoad={() => setStatus("loaded")}
              onError={() => setStatus("failed")}
              className={cn(
                "max-h-[60vh] w-auto max-w-full object-contain",
                status === "loaded" ? "opacity-100" : "opacity-0"
              )}
            />
          )}

          {hasPrev && (
            <button
              type="button"
              onClick={() => onSelectFigure(figures[selectedIndex - 1]!.figureNumber)}
              aria-label="Previous figure"
              className="absolute left-2 top-1/2 -translate-y-1/2 p-2 rounded-full bg-scrim-medium text-daintree-text/80 hover:text-text-primary hover:bg-overlay-raised transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary"
            >
              <ChevronLeft className="w-5 h-5" aria-hidden="true" />
            </button>
          )}
          {hasNext && (
            <button
              type="button"
              onClick={() => onSelectFigure(figures[selectedIndex + 1]!.figureNumber)}
              aria-label="Next figure"
              className="absolute right-2 top-1/2 -translate-y-1/2 p-2 rounded-full bg-scrim-medium text-daintree-text/80 hover:text-text-primary hover:bg-overlay-raised transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary"
            >
              <ChevronRight className="w-5 h-5" aria-hidden="true" />
            </button>
          )}
        </div>

        {/* Attribution frame — kept outside the <img> so a documentation image
            can't pass as Daintree's own UI. Figure number is the primary label;
            the source label and caption sit beneath it. */}
        <div className="flex flex-col gap-1 border-t border-border-default pt-3">
          <div className="flex items-baseline justify-between gap-2">
            <p className="text-sm font-medium text-text-primary">Figure {figure.figureNumber}</p>
            <p className="text-2xs text-daintree-text/45 shrink-0">
              {figure.figureLabel} · Daintree docs
            </p>
          </div>
          {figure.caption && (
            <p className="text-xs text-daintree-text/70 select-text">{figure.caption}</p>
          )}
        </div>

        {/* Local live region — VoiceOver drops aria-live updates made from
            outside the focused aria-modal (#9434), so it must sit inside the
            dialog body, not in the host panel. */}
        <span className="sr-only" aria-live="polite" aria-atomic="true">
          Viewing figure {figure.figureNumber} of {figures.length}
        </span>
      </AppDialog.BodyScroll>
    </AppDialog>
  );
}
