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
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

/**
 * Parse sanitized SVG into a live element, or null if it isn't usable.
 *
 * `image/svg+xml` parsing is namespace-strict, unlike the HTML parser that
 * `innerHTML` used to run: a document whose root `<svg>` omits `xmlns` (common
 * in hand-written and tool-exported files) parses into a null-namespace element
 * that renders blank. `sanitizeSvg` only requires the string to contain `<svg`,
 * so declare the namespace when it's absent rather than silently showing
 * nothing.
 */
function parseSanitizedSvg(sanitizedSvg: string): Element | null {
  const parse = (markup: string): Element | null => {
    const parsed = new DOMParser().parseFromString(markup, "image/svg+xml");
    // A parse failure yields a <parsererror> document rather than throwing.
    if (parsed.querySelector("parsererror")) return null;
    const root = parsed.documentElement;
    if (!root || root.localName !== "svg" || root.namespaceURI !== SVG_NAMESPACE) return null;
    return root;
  };

  const direct = parse(sanitizedSvg);
  if (direct) return direct;

  // Retry once with the namespace declared on the root element. Only rewrites
  // the opening tag, so sanitized content is otherwise untouched.
  if (!/\sxmlns\s*=/.test(sanitizedSvg)) {
    return parse(sanitizedSvg.replace(/<svg\b/i, `<svg xmlns="${SVG_NAMESPACE}"`));
  }
  return null;
}

function useInlineSvg(sanitizedSvg: string | null | undefined) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    if (!sanitizedSvg) {
      container.replaceChildren();
      return;
    }
    const svg = parseSanitizedSvg(sanitizedSvg);
    if (!svg) {
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
