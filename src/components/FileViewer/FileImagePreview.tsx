import { useEffect, useRef } from "react";
import { buildDaintreeFileUrl } from "./filePreviewKinds";

interface FileImagePreviewProps {
  /** Absolute path of the image being previewed. */
  filePath: string;
  /** Known root the `daintree-file://` protocol resolves the path against. */
  rootPath: string;
  /** Alt text — the file name, so a broken image still names its file. */
  alt: string;
  /**
   * Sanitized SVG markup. When present the SVG is inlined instead of loaded as
   * an `<img>`, so it scales with the viewport. Sanitization happens upstream;
   * raw SVG must never reach this component.
   */
  sanitizedSvg?: string | null;
  onError?: () => void;
  /** Height cap for the preview surface — dialogs and panes want different ones. */
  maxHeightClassName?: string;
}

/**
 * Inserts sanitized SVG through `DOMParser` rather than `innerHTML`.
 *
 * `sanitizeSvg` documents this explicitly: its output is safe to embed only via
 * DOM APIs that do not re-tokenize the markup as HTML, because an HTML reparse
 * can resurrect mutation-XSS vectors its regex pass cannot model. Parsing as
 * `image/svg+xml` and adopting the resulting node avoids that reparse.
 */
function useInlineSvg(sanitizedSvg: string | null | undefined) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    if (!sanitizedSvg) {
      container.replaceChildren();
      return;
    }
    const parsed = new DOMParser().parseFromString(sanitizedSvg, "image/svg+xml");
    const svg = parsed.documentElement;
    // A parse failure yields a <parsererror> document rather than throwing.
    if (!svg || svg.nodeName === "parsererror" || parsed.querySelector("parsererror")) {
      container.replaceChildren();
      return;
    }
    // replaceChildren keeps this idempotent, so StrictMode's double invoke in
    // dev re-runs it without stacking duplicate nodes.
    container.replaceChildren(document.importNode(svg, true));
    return () => container.replaceChildren();
  }, [sanitizedSvg]);

  return containerRef;
}

/**
 * Renders an image or inlined SVG preview.
 *
 * Shared by `FilePane` and `FileViewerModal` so both surfaces preview the same
 * files the same way — the file viewer existing twice is exactly what this
 * component set out to stop duplicating.
 */
export function FileImagePreview({
  filePath,
  rootPath,
  alt,
  sanitizedSvg,
  onError,
  maxHeightClassName = "max-h-[70vh]",
}: FileImagePreviewProps) {
  const svgContainerRef = useInlineSvg(sanitizedSvg);

  return (
    <div className="flex items-center justify-center p-6 min-h-[300px]">
      {sanitizedSvg ? (
        <div
          ref={svgContainerRef}
          role="img"
          aria-label={alt}
          className={`max-w-full ${maxHeightClassName} overflow-auto [&>svg]:max-w-full [&>svg]:h-auto`}
        />
      ) : (
        <img
          // Keyed by path so switching files remounts rather than showing the
          // previous image until the new one decodes.
          key={filePath}
          src={buildDaintreeFileUrl(filePath, rootPath)}
          alt={alt}
          className={`max-w-full ${maxHeightClassName} object-contain rounded`}
          draggable={false}
          onError={onError}
        />
      )}
    </div>
  );
}
