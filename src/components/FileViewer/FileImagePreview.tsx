import { useEffect, useEffectEvent } from "react";
import { SVG_DRAW_ERROR, SVG_PARSE_ERROR, renderableSvg, svgToDataUrl } from "@/lib/svg";
import { buildDaintreeFileUrl } from "./filePreviewKinds";
import { useImageErrorHandler } from "./previewRefusal";
import type { MediaPreviewError } from "./useMediaSourceUrl";

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
  /**
   * Called with the host's refusal when a remote window's host refused it; bare
   * for a failed raster load. SVG markup that can't be shown reports why as the
   * error's title.
   */
  onError?: (error?: MediaPreviewError) => void;
  /** Height cap for the preview surface — dialogs and panes want different ones. */
  maxHeightClassName?: string;
}

/**
 * Renders an image or SVG preview.
 *
 * Shared by `FilePane` and `FileBrowserViewer` so both surfaces preview the
 * same files the same way.
 *
 * SVG markup is shown as an `<img>` of its own data URL, never inserted into
 * this document. An SVG image fetches nothing but `data:` URLs, runs no script
 * and keeps its styles to itself, so CSS the regex sanitizer misses
 * (`u\72l(…)`, `image-set("…")`) cannot make this machine fetch a
 * `daintree-file://load` URL of its own disk. A remote view's SVG, and the
 * agent asking to show it, come from another machine.
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
  const svg = sanitizedSvg ? renderableSvg(sanitizedSvg) : null;
  const unrenderable = Boolean(sanitizedSvg) && svg === null;
  const rasterSrc =
    cacheBust === undefined
      ? buildDaintreeFileUrl(filePath, rootPath)
      : `${buildDaintreeFileUrl(filePath, rootPath)}&v=${encodeURIComponent(cacheBust)}`;
  const handleRasterError = useImageErrorHandler(rasterSrc, onError);

  // The loaders refuse unparseable markup before it gets here; a caller that
  // doesn't still hears about it instead of showing an empty stage.
  const reportUnrenderable = useEffectEvent(() => onError?.({ title: SVG_PARSE_ERROR }));
  useEffect(() => {
    if (unrenderable) reportUnrenderable();
  }, [unrenderable, sanitizedSvg]);

  return (
    <div className="flex items-center justify-center p-6 min-h-[300px]">
      {sanitizedSvg ? (
        svg && (
          <img
            src={svgToDataUrl(svg.markup)}
            alt={alt}
            className={`max-w-full ${maxHeightClassName} object-contain${svg.sized ? "" : " w-full h-auto"}`}
            draggable={false}
            onError={() => onError?.({ title: SVG_DRAW_ERROR })}
          />
        )
      ) : (
        <img
          // Keyed by path so switching files remounts rather than showing the
          // previous image until the new one decodes. Deliberately not keyed by
          // cacheBust: a rewritten image swaps its bytes in place, and the old
          // frame stays painted until the new one decodes.
          key={filePath}
          src={rasterSrc}
          alt={alt}
          className={`max-w-full ${maxHeightClassName} object-contain rounded-lg`}
          draggable={false}
          onError={handleRasterError}
        />
      )}
    </div>
  );
}
