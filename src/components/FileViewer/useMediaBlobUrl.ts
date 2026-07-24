import { useEffect, useEffectEvent, useMemo, useState } from "react";
import type { FileReadErrorCode } from "@shared/types/ipc/files";
import { buildDaintreeFileUrl } from "./filePreviewKinds";

/** Why a preview couldn't play, split so callers can render a headline and a way forward. */
export interface MediaPreviewError {
  /** Names what happened. Callers with a titled error surface use it as the title. */
  title: string;
  /** Second line naming the next action. */
  description?: string;
  /** Read-error code for panes that gate their error surface on one. */
  code?: FileReadErrorCode;
}

interface UseMediaBlobUrlOptions {
  /** Absolute path of the media being previewed. */
  filePath: string;
  /** Known root the `daintree-file://` protocol resolves the path against. */
  rootPath: string;
  /**
   * Changed to force a fresh media request for the same path — the protocol
   * serves `no-store`, but the blob is a byte-snapshot of the fetch, so a
   * rewritten file needs a new URL to show new bytes.
   */
  reloadKey?: string | number;
  /** Ceiling for a single preview, enforced against both the declared length and the blob. */
  maxBytes: number;
  /** Reported instead of the generic failure when the file exceeds `maxBytes`. */
  tooLargeError: MediaPreviewError;
  /** Called when the media can't be fetched; an error overrides the caller's generic copy. */
  onError?: (error?: MediaPreviewError) => void;
}

/**
 * Fetches a file from `daintree-file://` into a Blob and hands back an object
 * URL for a media element to play.
 *
 * Shared by `FileVideoPreview` and `FileAudioPreview` so the fetch, size caps,
 * abort sequencing, and object-URL lifetime have exactly one owner — the parts
 * that are easy to get subtly wrong and impossible to notice when they drift.
 *
 * The bytes are fetch()ed into a Blob rather than pointing the element's `src`
 * at the protocol directly. Chromium's custom-scheme media loader is
 * single-shot: it cannot consume any follow-up range request for the same
 * resource, so every file whose index trails its payload (the default mp4
 * layout from most recorders) dies with a demuxer error moments after playback
 * starts (electron/electron#51442; verified against Electron 42). fetch()
 * doesn't go through the media loader, and a blob URL is fully seekable
 * in-renderer.
 */
export function useMediaBlobUrl({
  filePath,
  rootPath,
  reloadKey,
  maxBytes,
  tooLargeError,
  onError,
}: UseMediaBlobUrlOptions): { objectUrl: string | null; fetching: boolean } {
  const src = useMemo(() => {
    const url = buildDaintreeFileUrl(filePath, rootPath);
    // Cache-busting query param only — the protocol handler ignores it.
    // Null-checked, not truthiness: a numeric key of 0 is a valid value.
    return reloadKey != null ? `${url}&v=${encodeURIComponent(reloadKey)}` : url;
  }, [filePath, rootPath, reloadKey]);

  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [fetching, setFetching] = useState(true);

  // Effect events so the fetch effect keys on the source and cap alone (both
  // stable) — callers pass inline closures, and refetching the file on every
  // parent render would discard playback position each time anything else in
  // the pane changes.
  const reportError = useEffectEvent(() => onError?.());
  const reportTooLarge = useEffectEvent(() => onError?.(tooLargeError));

  useEffect(() => {
    const controller = new AbortController();
    let url: string | null = null;
    setFetching(true);
    setObjectUrl(null);

    void fetch(src, { signal: controller.signal })
      .then(async (response) => {
        // Guarded before any state write: an already-settled fetch promise can
        // run this reaction after cleanup aborted it, and reporting then would
        // clear the skeleton / flag an error on the file shown NEXT.
        if (controller.signal.aborted) return;
        if (!response.ok) throw new Error(`daintree-file responded ${response.status}`);
        const declaredLength = Number(response.headers.get("content-length"));
        if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
          // Drop the unread body so the protocol stream (and its fd) closes
          // now rather than when the response gets collected.
          void response.body?.cancel().catch(() => {});
          setFetching(false);
          reportTooLarge();
          return;
        }
        const blob = await response.blob();
        if (controller.signal.aborted) return;
        if (blob.size > maxBytes) {
          setFetching(false);
          reportTooLarge();
          return;
        }
        url = URL.createObjectURL(blob);
        setObjectUrl(url);
        setFetching(false);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setFetching(false);
        reportError();
      });

    return () => {
      controller.abort();
      // Safe while the media element below is unmounting with it: revoking
      // detaches the URL from the blob for new loads; the element is gone
      // either way.
      if (url) URL.revokeObjectURL(url);
    };
  }, [src, maxBytes]);

  return { objectUrl, fetching };
}
