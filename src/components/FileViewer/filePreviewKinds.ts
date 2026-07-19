/**
 * Shared classification + URL helpers for previewable (non-text) files.
 *
 * Extracted from `FileViewerModal` so `FilePane` classifies files identically:
 * the two surfaces render the same file kinds and previously diverged, which
 * meant opening an image in one worked and errored in the other.
 */

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico"]);
const SVG_EXTENSION = "svg";

function extensionOf(filePath: string): string {
  return filePath.split(".").pop()?.toLowerCase() ?? "";
}

/** Raster images and SVG — everything rendered as a picture rather than text. */
export function isImageFilePath(filePath: string): boolean {
  const ext = extensionOf(filePath);
  return IMAGE_EXTENSIONS.has(ext) || ext === SVG_EXTENSION;
}

/** SVG specifically: read as text and sanitized before inlining, not <img>-loaded. */
export function isSvgFilePath(filePath: string): boolean {
  return extensionOf(filePath) === SVG_EXTENSION;
}

/**
 * URL for the custom `daintree-file://` protocol, which serves a file from
 * inside a known root. Used as an `<img>` src so raster images never round-trip
 * through a base64 IPC read.
 */
export function buildDaintreeFileUrl(filePath: string, rootPath: string): string {
  return `daintree-file://load?path=${encodeURIComponent(filePath)}&root=${encodeURIComponent(rootPath)}`;
}
