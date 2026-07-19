import { createTrustedHTML } from "@/lib/trustedTypesPolicy";
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
  return (
    <div className="flex items-center justify-center p-6 min-h-[300px]">
      {sanitizedSvg ? (
        <div
          className={`max-w-full ${maxHeightClassName} overflow-auto [&>svg]:max-w-full [&>svg]:h-auto`}
          dangerouslySetInnerHTML={{ __html: createTrustedHTML(sanitizedSvg) }}
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
