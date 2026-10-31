import { useMemo, type MouseEvent } from "react";
import { FileCode, FileWarning } from "lucide-react";
import { FileUnavailableState } from "@/components/FileViewer/FileUnavailableState";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { HTML_PREVIEW_PARTITION } from "@shared/utils/partitionUtils";

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
  /**
   * Switches the host to Source — the fallback's one way out, and a view only
   * the host owns. The click rides along so the host can tell a keyboard
   * activation from a pointer one when it hands focus to its Source segment.
   */
  onShowSource: (event: MouseEvent<HTMLButtonElement>) => void;
  className?: string;
}

/**
 * Rendered view of an HTML file (#11191): the page in its own `<webview>`
 * guest, not a frame of the app. The document is served by the
 * `daintree-html://` protocol with its own token-scoped CSP, whose `sandbox
 * allow-scripts` gives it an opaque origin: its scripts run, but with no
 * preload it has no bridge, and its session shares no storage with the app.
 * Its network egress is closed by main, not by this element: the
 * {@link HTML_PREVIEW_PARTITION} session refuses every TCP connection through
 * its proxy, and each guest gets a WebRTC policy that allows no UDP — which
 * Chromium can only apply per WebContents, so an iframe in the app could never
 * have it (#15793). Source mode stays on CodeViewer (owned by whichever surface
 * hosts this — FilePane, the file browser's viewer), so this component is
 * rendered-only — a thin, non-lazy wrapper with no heavy deps.
 */
export function HtmlViewer({
  previewUrl,
  reloadNonce,
  title,
  onShowSource,
  className,
}: HtmlViewerProps) {
  const src = useMemo(() => {
    if (!previewUrl) return null;
    const separator = previewUrl.includes("?") ? "&" : "?";
    return `${previewUrl}${separator}v=${reloadNonce}`;
  }, [previewUrl, reloadNonce]);

  if (!src) {
    // Both causes of a missing URL are about where the file sits, not what is
    // in it, so the copy says so and offers Source in the body: at narrow
    // widths the toolbar's Source segment is folded into a menu.
    return (
      <FileUnavailableState
        icon={FileWarning}
        title="Can't preview this file here"
        description="Previews don't open from this location. The markup is readable in Source."
        data-testid="html-preview-unavailable"
        action={
          <Button variant="subtle" size="sm" onClick={onShowSource}>
            <FileCode />
            View source
          </Button>
        }
      />
    );
  }

  return (
    <webview
      // Remount on file switch so a stale document never lingers while the new
      // one loads; the nonce query handles same-file reloads.
      key={previewUrl}
      src={src}
      // Main attaches a daintree-html:// src only in this partition, and this
      // partition only with that src.
      partition={HTML_PREVIEW_PARTITION}
      title={title}
      className={cn("h-full w-full border-0 bg-white", className)}
      data-testid="html-preview-frame"
    />
  );
}
