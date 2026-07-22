export interface DiffMediaReadFileVersionsPayload {
  /** Absolute worktree root the file path is resolved against. */
  cwd: string;
  /** Repo-relative path of the image file. */
  filePath: string;
}

export type DiffMediaSideError = "NOT_FOUND" | "TOO_LARGE" | "UNSUPPORTED" | "ERROR";

export type DiffMediaSide =
  { ok: true; dataUrl: string; byteSize: number } | { ok: false; error: DiffMediaSideError };

export interface DiffMediaFileVersions {
  head: DiffMediaSide;
  working: DiffMediaSide;
}

/** Per-side byte cap for image compare payloads. */
export const DIFF_MEDIA_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Single source of truth for compare-eligible image extensions — the main
 * process derives MIME types from it and the renderer derives eligibility,
 * so the two can't drift.
 */
export const DIFF_MEDIA_IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  svg: "image/svg+xml",
};

export function getDiffMediaImageMime(filePath: string): string | null {
  const dot = filePath.lastIndexOf(".");
  if (dot === -1) return null;
  return DIFF_MEDIA_IMAGE_MIME_BY_EXTENSION[filePath.slice(dot + 1).toLowerCase()] ?? null;
}
