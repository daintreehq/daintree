import { LOCAL_HOST_ID } from "@shared/types/remoteHosts";

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

// Audio Chromium decodes natively. m4a/aac are in because stock Electron builds
// ffmpeg with proprietary codecs (the same reason mp4/m4v play above) —
// canPlayType("audio/mp4; codecs=\"mp4a.40.2\"") answers "probably" on
// Electron 42 / Chromium 148. `ogg` is audio, not video: the video side claims
// `ogv`, so the two never collide.
const AUDIO_EXTENSIONS = new Set(["mp3", "wav", "flac", "ogg", "oga", "opus", "m4a", "aac"]);

// Audio Chromium has no decoder for, at any MIME spelling. Classified so the
// viewer says "can't play this format" rather than falling through to the text
// path's "Binary file — cannot display".
const UNSUPPORTED_AUDIO_EXTENSIONS = new Set(["wma", "aiff", "aif", "mid", "midi", "amr"]);

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

/** Videos Chromium plays natively — served from daintree-media:// to a <video> element. */
export function isVideoFilePath(filePath: string): boolean {
  return VIDEO_EXTENSIONS.has(extensionOf(filePath));
}

/** Video containers Chromium can't demux — recognized only to explain why they won't play. */
export function isUnsupportedVideoFilePath(filePath: string): boolean {
  return UNSUPPORTED_VIDEO_EXTENSIONS.has(extensionOf(filePath));
}

/** PDFs — framed from daintree-pdf:// and rendered by Chromium's built-in viewer. */
export function isPdfFilePath(filePath: string): boolean {
  return extensionOf(filePath) === "pdf";
}

/** Copy for containers in the unsupported set — shared so both panes say the same thing. */
export const UNSUPPORTED_VIDEO_MESSAGE =
  "Can't play this video format — only MP4, WebM, and Ogg are supported";

/** Audio Chromium plays natively — served from daintree-media:// to an <audio> element. */
export function isAudioFilePath(filePath: string): boolean {
  return AUDIO_EXTENSIONS.has(extensionOf(filePath));
}

/** Audio formats Chromium can't decode — recognized only to explain why they won't play. */
export function isUnsupportedAudioFilePath(filePath: string): boolean {
  return UNSUPPORTED_AUDIO_EXTENSIONS.has(extensionOf(filePath));
}

/**
 * Copy for audio in the unsupported set, shared by the panes that classify it.
 * DiffPane deliberately doesn't: like unsupported video, it leaves these to the
 * diff view's own binary fallback rather than claiming a player it won't show.
 */
export const UNSUPPORTED_AUDIO_MESSAGE =
  "Can't play this audio format — only MP3, WAV, FLAC, Ogg, Opus, M4A, and AAC are supported";

/**
 * Whether a path is worth offering "copy contents" for, judged on extension
 * alone — the answer a surface needs *before* reading anything.
 *
 * "Candidate" rather than "isText": the negative is authoritative (a `.png` has
 * no text to copy and never will), while the positive only says nothing here
 * rules it out. An extensionless binary still reads as a candidate and is
 * caught at read time, where `files:read` already reports BINARY_FILE.
 *
 * Surfaces that have already loaded the file must gate on their own load state
 * instead: that knows about binary detection, the 512KiB cap and LFS pointers,
 * none of which an extension can see.
 */
export function isFileContentsCopyCandidate(filePath: string): boolean {
  return !(
    isImageFilePath(filePath) ||
    isVideoFilePath(filePath) ||
    isUnsupportedVideoFilePath(filePath) ||
    isAudioFilePath(filePath) ||
    isUnsupportedAudioFilePath(filePath) ||
    isPdfFilePath(filePath)
  );
}

/**
 * The remote host this view's files live on, or null for a view of this
 * machine. A remote view's preview URLs name the host so this machine's
 * protocol handler fetches the host's file instead of reading its own copy of
 * the same path.
 */
function viewRemoteHostId(): string | null {
  const id = typeof window === "undefined" ? undefined : window.__DAINTREE_HOST_ID__?.id;
  return id && id !== LOCAL_HOST_ID ? id : null;
}

let previewCapability: string | null = null;
let previewCapabilityRequest: Promise<string | null> | null = null;

/**
 * Fetch this view's preview capability once and keep it for the view's life.
 * A protocol request carries no sender, so the host serves a remote view's
 * preview only when its URL carries the token main minted for that view.
 * Resolves null without any IPC for a view of this machine.
 */
export function primeHostPreviewCapability(): Promise<string | null> {
  if (previewCapability !== null) return Promise.resolve(previewCapability);
  if (viewRemoteHostId() === null) return Promise.resolve(null);
  if (previewCapabilityRequest) return previewCapabilityRequest;
  const fileTransfer = window.electron?.fileTransfer;
  if (!fileTransfer?.getPreviewCapability) return Promise.resolve(null);
  const request = fileTransfer
    .getPreviewCapability()
    .then((capability) => {
      previewCapability = capability;
      return capability;
    })
    .catch(() => null)
    .finally(() => {
      // A failed fetch leaves nothing cached, so the next preview asks again.
      if (previewCapabilityRequest === request) previewCapabilityRequest = null;
    });
  previewCapabilityRequest = request;
  return request;
}

/** Test seam: forget the cached capability. */
export function resetHostPreviewCapabilityForTests(): void {
  previewCapability = null;
  previewCapabilityRequest = null;
}

/**
 * `load` for this machine, `host/<hostId>/<capability>/load` for the remote
 * host this view is bound to. Local URLs keep exactly the shape they always
 * had. The capability is only valid for the view's own host, so a URL naming
 * any other host (or built before the capability arrived) goes without it and
 * the host refuses it rather than serving it under the wrong view.
 */
function previewAuthority(hostId: string | null): string {
  if (hostId === null) return "load";
  const host = `host/${encodeURIComponent(hostId)}`;
  if (hostId !== viewRemoteHostId()) return `${host}/load`;
  if (previewCapability === null) {
    void primeHostPreviewCapability();
    return `${host}/load`;
  }
  return `${host}/${previewCapability}/load`;
}

function previewQuery(filePath: string, rootPath: string): string {
  return `?path=${encodeURIComponent(filePath)}&root=${encodeURIComponent(rootPath)}`;
}

/**
 * URL for the custom `daintree-file://` protocol, which serves a file from
 * inside a known root. Used as an `<img>` src so raster images never round-trip
 * through a base64 IPC read.
 */
export function buildDaintreeFileUrl(
  filePath: string,
  rootPath: string,
  hostId: string | null = viewRemoteHostId()
): string {
  return `daintree-file://${previewAuthority(hostId)}${previewQuery(filePath, rootPath)}`;
}

/**
 * URL for the custom `daintree-media://` protocol — the range-serving sibling of
 * `daintree-file://`, used directly as a `<video>`/`<audio>` src so the element
 * requests what it needs instead of this side downloading the whole file
 * (#12242). It is registered `standard: true`, the privilege the upstream report
 * behind the old blob detour identified as the missing one.
 */
export function buildDaintreeMediaUrl(
  filePath: string,
  rootPath: string,
  hostId: string | null = viewRemoteHostId()
): string {
  // Trailing `/` on the authority is written out rather than left to Chromium:
  // a `standard: true` scheme canonicalizes to it anyway, and matching that
  // shape here keeps the URL we set identical to the one the handler receives.
  return `daintree-media://${previewAuthority(hostId)}/${previewQuery(filePath, rootPath)}`;
}

/**
 * URL for the custom `daintree-pdf://` protocol — a PDF-only sibling of
 * `daintree-file://`, kept separate because it is the one scheme allowed in
 * `frame-src`. Used as an iframe `src` so Chromium's built-in PDFium viewer
 * renders the document.
 */
export function buildDaintreePdfUrl(
  filePath: string,
  rootPath: string,
  hostId: string | null = viewRemoteHostId()
): string {
  return `daintree-pdf://${previewAuthority(hostId)}${previewQuery(filePath, rootPath)}`;
}
