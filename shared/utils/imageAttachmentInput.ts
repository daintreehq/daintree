/**
 * Image file extensions the composer and terminal treat as image attachments.
 * Shared by the hybrid input bar, the terminal drop handler and the pty-host
 * submit path, so all three agree on what counts as an image.
 */
export const IMAGE_EXTENSIONS = /\.(png|jpe?g|bmp|tiff?|avif|heic)$/i;

/** Upper bound on image paths one submission may carry across IPC. */
export const MAX_SUBMIT_IMAGE_PATHS = 32;

const MAX_IMAGE_PATH_LENGTH = 4096;

/**
 * Whether `filePath` can be handed to an agent CLI as an image attachment:
 * an image by extension, a native absolute local path, and free of control
 * characters. Says nothing about whether the file exists — callers that can
 * stat do so separately.
 *
 * A UNC path (`\\host\share`) or a URL names a file on another machine; the
 * CLI would treat it as text at best, so it is refused rather than claimed as
 * an attachment. Tab is refused here too, unlike a plain path drop: the CLIs
 * trim a pasted path before testing it, and a path that only resolves with its
 * whitespace intact is not one they will recognise.
 */
export function isImageAttachmentPath(filePath: string): boolean {
  if (filePath.length === 0 || filePath.length > MAX_IMAGE_PATH_LENGTH) return false;
  if (!IMAGE_EXTENSIONS.test(filePath)) return false;
  if (filePath !== filePath.trim()) return false;
  for (let index = 0; index < filePath.length; index++) {
    const code = filePath.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return false;
  }
  if (filePath.startsWith("//") || filePath.startsWith("\\\\")) return false;
  if (filePath.startsWith("/")) return true;
  return /^[A-Za-z]:[\\/]/.test(filePath);
}

export type ImageInputSegment = { kind: "text"; text: string } | { kind: "image"; path: string };

const isBoundaryBefore = (char: string | undefined): boolean =>
  char === undefined || /[\s([{]/.test(char);

const isBoundaryAfter = (char: string | undefined): boolean =>
  char === undefined || /[\s)\]}.,;:!?]/.test(char);

/**
 * Split `text` into ordered text and image segments, locating each of
 * `imagePaths` in turn after the previous match.
 *
 * The paths are searched for rather than addressed by offset because the text
 * that reaches the pty-host has been through token expansion (`@terminal`,
 * `@diff`, an appended instruction) since the composer recorded its chips; a
 * literal search survives that where an offset would not. A match must sit on
 * a token boundary so a chip path cannot be found inside a longer path. A path
 * that cannot be found is skipped and stays in the text as it was.
 *
 * Returns only text segments when nothing matched, so callers can keep their
 * existing single-write path for that case.
 */
export function splitImageInputSegments(
  text: string,
  imagePaths: readonly string[]
): ImageInputSegment[] {
  const segments: ImageInputSegment[] = [];
  let cursor = 0;

  for (const imagePath of imagePaths) {
    if (imagePath.length === 0) continue;
    let index = text.indexOf(imagePath, cursor);
    while (
      index !== -1 &&
      !(
        isBoundaryBefore(index === 0 ? undefined : text[index - 1]) &&
        isBoundaryAfter(text[index + imagePath.length])
      )
    ) {
      index = text.indexOf(imagePath, index + 1);
    }
    if (index === -1) continue;
    if (index > cursor) segments.push({ kind: "text", text: text.slice(cursor, index) });
    segments.push({ kind: "image", path: imagePath });
    cursor = index + imagePath.length;
  }

  if (cursor < text.length) segments.push({ kind: "text", text: text.slice(cursor) });
  return segments;
}
