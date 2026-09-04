import { useMemo } from "react";
import { FileWarning } from "lucide-react";
import { EmptyState } from "@/components/ui/EmptyState";
import { cn } from "@/lib/utils";

export interface HtmlViewerProps {
  /**
   * `daintree-html://<token>/<relpath>` URL minted by the files:read handler.
   * Null when the read returned no preview URL (e.g. the file moved outside its
   * root); the viewer shows a fallback rather than a blank frame.
   */
  previewUrl: string | null;
  /**
   * Bumped by the host surface on every (re)load so a rewritten file
   * re-renders. The cross-origin sandboxed frame can't be `location.reload()`-ed
   * from here, so a changing cache-buster query is the only way to force a fresh
   * navigation; the daintree-html:// handler ignores the query when mapping to
   * disk.
   */
  reloadNonce: number;
  /** Accessible name for the frame (the file name). */
  title: string;
  className?: string;
}

/**
 * Rendered view of an HTML file (#11191): the page in a sandboxed iframe. The
 * document is served by the `daintree-html://` protocol with its own
 * token-scoped CSP; `sandbox="allow-scripts"` WITHOUT `allow-same-origin` gives
 * it an opaque origin, so its scripts run but it cannot reach the app, the
 * bridge, storage, or the network. Source mode stays on CodeViewer (owned by
 * whichever surface hosts this — FilePane, the file browser's viewer), so this
 * component is rendered-only — a thin, non-lazy iframe wrapper with no heavy
 * deps.
 */
export function HtmlViewer({ previewUrl, reloadNonce, title, className }: HtmlViewerProps) {
  const src = useMemo(() => {
    if (!previewUrl) return null;
    const separator = previewUrl.includes("?") ? "&" : "?";
    return `${previewUrl}${separator}v=${reloadNonce}`;
  }, [previewUrl, reloadNonce]);

  if (!src) {
    return (
      <div className="flex h-full w-full items-center justify-center p-6">
        <EmptyState
          variant="zero-data"
          scale="canvas"
          icon={<FileWarning className="h-6 w-6" />}
          title="Can't render this file"
          description="Switch to Source to view the markup."
        />
      </div>
    );
  }

  return (
    <iframe
      // Remount on file switch so a stale document never lingers while the new
      // one loads; the nonce query handles same-file reloads.
      key={previewUrl}
      src={src}
      title={title}
      // No allow-same-origin: the frame gets an opaque origin and cannot touch
      // the parent DOM, window.electron, storage, or (with connect-src 'none')
      // the network. allow-scripts lets the page's own scripts run.
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      className={cn("h-full w-full border-0 bg-white", className)}
      data-testid="html-preview-frame"
    />
  );
}
