import { svgToDataUrl } from "@/lib/svg";
import { buildDaintreeFileUrl } from "./filePreviewKinds";

interface FileImagePreviewProps {
  /** Absolute path of the image being previewed. */
  filePath: string;
  /** Known root the `daintree-file://` protocol resolves the path against. */
  rootPath: string;
  /** Alt text — the file name, so a broken image still names its file. */
  alt: string;
  /**
   * Sanitized SVG markup. When present it is shown as an image of itself rather
   * than loaded through the protocol. Sanitization happens upstream; raw SVG
   * must never reach this component.
   */
  sanitizedSvg?: string | null;
  /**
   * Opaque token appended to the raster `daintree-file://` URL. The protocol URL
   * is otherwise a pure function of path and root, so a rewritten image on disk
   * is never refetched — `Cache-Control: no-store` only governs a request that
   * actually happens. Changing this changes the URL, which is what asks for one.
   * Ignored for SVG markup, which is re-read and re-sanitized upstream.
   */
  cacheBust?: string;
  onError?: () => void;
  /** Height cap for the preview surface — dialogs and panes want different ones. */
  maxHeightClassName?: string;
}

/**
 * SVG markup is shown as an `<img>` of its own data URL, never inserted into
 * this document. An SVG image loads no subresources and runs no script, and
 * its styles stay inside it, so CSS the regex sanitizer misses (`u\72l(…)`,
 * `image-set("…")`) cannot make this machine fetch a `daintree-file://load` URL
 * of its own disk. A remote view's SVG, and the agent asking to show it, come
 * from another machine.
 */
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

/**
 * The markup to render, or null if it isn't usable.
 *
 * `image/svg+xml` is namespace-strict: a root `<svg>` that omits `xmlns` (common
 * in hand-written and tool-exported files) renders blank. `sanitizeSvg` only
 * requires the string to contain `<svg`, so declare the namespace when it's
 * absent rather than silently showing nothing.
 */
function renderableSvgMarkup(sanitizedSvg: string): string | null {
  const parses = (markup: string): boolean => {
    const parsed = new DOMParser().parseFromString(markup, "image/svg+xml");
    // A parse failure yields a <parsererror> document rather than throwing.
    if (parsed.querySelector("parsererror")) return false;
    const root = parsed.documentElement;
    return !!root && root.localName === "svg" && root.namespaceURI === SVG_NAMESPACE;
  };

  if (parses(sanitizedSvg)) return sanitizedSvg;

  // Retry once with the namespace declared on the root element. Only rewrites
  // the opening tag, so sanitized content is otherwise untouched.
  if (!/\sxmlns\s*=/.test(sanitizedSvg)) {
    const declared = sanitizedSvg.replace(/<svg\b/i, `<svg xmlns="${SVG_NAMESPACE}"`);
    if (parses(declared)) return declared;
  }
  return null;
}

/**
 * Renders an image or SVG preview.
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
  cacheBust,
  onError,
  maxHeightClassName = "max-h-[70vh]",
}: FileImagePreviewProps) {
  const svgMarkup = sanitizedSvg ? renderableSvgMarkup(sanitizedSvg) : null;

  return (
    <div className="flex items-center justify-center p-6 min-h-[300px]">
      {sanitizedSvg ? (
        svgMarkup && (
          <img
            src={svgToDataUrl(svgMarkup)}
            alt={alt}
            className={`max-w-full ${maxHeightClassName} object-contain`}
            draggable={false}
            onError={onError}
          />
        )
      ) : (
        <img
          // Keyed by path so switching files remounts rather than showing the
          // previous image until the new one decodes. Deliberately not keyed by
          // cacheBust: a rewritten image swaps its bytes in place, and the old
          // frame stays painted until the new one decodes.
          key={filePath}
          src={
            cacheBust === undefined
              ? buildDaintreeFileUrl(filePath, rootPath)
              : `${buildDaintreeFileUrl(filePath, rootPath)}&v=${encodeURIComponent(cacheBust)}`
          }
          alt={alt}
          className={`max-w-full ${maxHeightClassName} object-contain rounded-lg`}
          draggable={false}
          onError={onError}
        />
      )}
    </div>
  );
}
