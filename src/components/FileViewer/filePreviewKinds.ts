/**
 * Shared classification + URL helpers for previewable (non-text) files.
 *
 * Extracted from `FileViewerModal` so `FilePane` classifies files identically:
 * the two surfaces render the same file kinds and previously diverged, which
 * meant opening an image in one worked and errored in the other.
 */

// apng is listed alongside png because the extension — not the container — is
// what routes a file here: an .apng is a valid PNG, but without its own entry it
// falls through to the text path and reports "Binary file". Chromium decodes and
// animates both apng and avif natively in an <img>.
const IMAGE_EXTENSIONS = new Set([
  "png",
  "apng",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "avif",
  "bmp",
  "ico",
]);
const SVG_EXTENSION = "svg";

// Containers Chromium's media pipeline demuxes natively (stock Electron ships
// H.264/AAC, so mp4/m4v are safe). mov/mkv/avi/wmv are deliberately absent:
// Chromium doesn't parse those containers even when the inner codec is
// supported, so offering a <video> element for them would just show a decode
// error instead of a clear message.
const VIDEO_EXTENSIONS = new Set(["mp4", "m4v", "webm", "ogv"]);

// Video containers users plausibly open but Chromium cannot demux. Classified
// separately so the viewer can say "can't play this format" rather than
// falling through to the text path's misleading size/binary errors.
const UNSUPPORTED_VIDEO_EXTENSIONS = new Set(["mov", "mkv", "avi", "wmv"]);

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

/** Videos Chromium plays natively — served via daintree-file:// to a <video> element. */
export function isVideoFilePath(filePath: string): boolean {
  return VIDEO_EXTENSIONS.has(extensionOf(filePath));
}

/** Video containers Chromium can't demux — recognized only to explain why they won't play. */
export function isUnsupportedVideoFilePath(filePath: string): boolean {
  return UNSUPPORTED_VIDEO_EXTENSIONS.has(extensionOf(filePath));
}

/** Copy for containers in the unsupported set — shared so both panes say the same thing. */
export const UNSUPPORTED_VIDEO_MESSAGE =
  "Can't play this video format — only MP4, WebM, and Ogg are supported";

/**
 * URL for the custom `daintree-file://` protocol, which serves a file from
 * inside a known root. Used as an `<img>` src so raster images never round-trip
 * through a base64 IPC read.
 */
export function buildDaintreeFileUrl(filePath: string, rootPath: string): string {
  return `daintree-file://load?path=${encodeURIComponent(filePath)}&root=${encodeURIComponent(rootPath)}`;
}
