import { useEffect, useEffectEvent, useMemo, useState } from "react";
import type { FileReadErrorCode } from "@shared/types/ipc/files";
import { Skeleton, SkeletonBone, SkeletonHint } from "@/components/ui/Skeleton";
import { buildDaintreeFileUrl } from "./filePreviewKinds";

// Blob previews hold the whole file in Chromium's blob storage (memory, then
// disk-backed), so cap what one preview may pull in. A 4K screen recording
// runs ~10MB/min; 1GiB covers over an hour before the viewer says no.
const VIDEO_PREVIEW_MAX_BYTES = 1024 * 1024 * 1024;

/** Why a preview couldn't play, split so callers can render a headline and a way forward. */
export interface VideoPreviewError {
  /** Names what happened. Callers with a titled error surface use it as the title. */
  title: string;
  /** Second line naming the next action. */
  description?: string;
  /** Read-error code for panes that gate their error surface on one. */
  code?: FileReadErrorCode;
}

const VIDEO_TOO_LARGE_ERROR: VideoPreviewError = {
  title: "This video is too large to preview",
  description: "Open it outside Daintree to watch it.",
  code: "FILE_TOO_LARGE",
};

interface FileVideoPreviewProps {
  /** Absolute path of the video being previewed. */
  filePath: string;
  /** Known root the `daintree-file://` protocol resolves the path against. */
  rootPath: string;
  /** Accessible label — the file name, so a failed video still names its file. */
  label: string;
  /**
   * Changed to force a fresh media request for the same path — the protocol
   * serves `no-store`, but the blob is a byte-snapshot of the fetch, so a
   * rewritten file needs a new URL to show new bytes.
   */
  reloadKey?: string | number;
  /** Called when the video can't be fetched or played; an error overrides the caller's generic copy. */
  onError?: (error?: VideoPreviewError) => void;
  /** Height cap for the preview surface — dialogs and panes want different ones. */
  maxHeightClassName?: string;
}

/**
 * Renders an inline video player for the formats Chromium decodes natively.
 *
 * Shared by `FilePane`, `FileBrowserViewer`, and `DiffPane` so every surface
 * plays the same files the same way — mirroring `FileImagePreview`'s role for
 * images.
 *
 * The bytes are fetch()ed from the `daintree-file://` protocol into a Blob and
 * played through an object URL rather than pointing `<video src>` at the
 * protocol directly. Chromium's custom-scheme media loader is single-shot: it
 * cannot consume any follow-up range request for the same resource, so every
 * video whose moov atom trails the mdat (the default mp4 layout from most
 * recorders) dies with a demuxer error moments after playback starts
 * (electron/electron#51442; verified against Electron 42). fetch() doesn't go
 * through the media loader, and a blob URL is fully seekable in-renderer.
 */
export function FileVideoPreview({
  filePath,
  rootPath,
  label,
  reloadKey,
  onError,
  maxHeightClassName = "max-h-[70vh]",
}: FileVideoPreviewProps) {
  const src = useMemo(() => {
    const url = buildDaintreeFileUrl(filePath, rootPath);
    // Cache-busting query param only — the protocol handler ignores it.
    // Null-checked, not truthiness: a numeric key of 0 is a valid value.
    return reloadKey != null ? `${url}&v=${encodeURIComponent(reloadKey)}` : url;
  }, [filePath, rootPath, reloadKey]);

  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [fetching, setFetching] = useState(true);

  // Effect events so the fetch effect keys on `src` alone — callers pass
  // inline closures, and refetching the file on every parent render would
  // discard playback position each time anything else in the pane changes.
  const reportError = useEffectEvent((error?: VideoPreviewError) => onError?.(error));

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
        if (Number.isFinite(declaredLength) && declaredLength > VIDEO_PREVIEW_MAX_BYTES) {
          // Drop the unread body so the protocol stream (and its fd) closes
          // now rather than when the response gets collected.
          void response.body?.cancel().catch(() => {});
          setFetching(false);
          reportError(VIDEO_TOO_LARGE_ERROR);
          return;
        }
        const blob = await response.blob();
        if (controller.signal.aborted) return;
        if (blob.size > VIDEO_PREVIEW_MAX_BYTES) {
          setFetching(false);
          reportError(VIDEO_TOO_LARGE_ERROR);
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
      // Safe while the <video> below is unmounting with it: revoking detaches
      // the URL from the blob for new loads; the element is gone either way.
      if (url) URL.revokeObjectURL(url);
    };
  }, [src]);

  return (
    <div className="flex items-center justify-center p-6 min-h-[300px]">
      {objectUrl ? (
        <video
          // Keyed by the object URL so switching files (or reloading) remounts
          // the element rather than continuing playback of the previous source.
          key={objectUrl}
          src={objectUrl}
          controls
          // No fullscreen or PiP: both detach playback from the pane into
          // window-level surfaces the IDE's window/view management doesn't own.
          controlsList="nofullscreen"
          disablePictureInPicture
          preload="metadata"
          aria-label={label}
          className={`max-w-full ${maxHeightClassName} rounded`}
          onError={() => onError?.()}
        />
      ) : fetching ? (
        // The whole file downloads before playback starts, so this wait is
        // routinely past a second and, on a long recording, past five — a
        // skeleton in the player's shape, not a spinner. `SkeletonBone` carries
        // the 400ms anti-flicker gate.
        <div className="flex w-full max-w-md flex-col items-center gap-3">
          <Skeleton label="Loading video" className="w-full">
            <SkeletonBone className="aspect-video w-full" />
          </Skeleton>
          {/* Sibling, never nested: the wrapper's aria-busy silences mutations
              inside its own subtree. */}
          <SkeletonHint />
        </div>
      ) : null}
    </div>
  );
}
