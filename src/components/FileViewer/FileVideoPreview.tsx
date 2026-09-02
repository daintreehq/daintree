import { useEffect, useEffectEvent } from "react";
import { Skeleton, SkeletonBone, SkeletonHint } from "@/components/ui/Skeleton";
import { useMediaBlobUrl } from "./useMediaBlobUrl";
import type { MediaPreviewError } from "./useMediaBlobUrl";

// Blob previews hold the whole file in Chromium's blob storage (memory, then
// disk-backed), so cap what one preview may pull in. A 4K screen recording
// runs ~10MB/min; 1GiB covers over an hour before the viewer says no.
const VIDEO_PREVIEW_MAX_BYTES = 1024 * 1024 * 1024;

/** Why a preview couldn't play, split so callers can render a headline and a way forward. */
export type VideoPreviewError = MediaPreviewError;

const VIDEO_TOO_LARGE_ERROR: MediaPreviewError = {
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
  /**
   * Reports whether this preview is mid-playback, so an owner that would
   * otherwise move `reloadKey` can hold off (#12165). Always taken back on
   * unmount or a source change: a fresh element starts paused and fires no
   * `pause` of its own, so an owner left holding the last `true` would suppress
   * reloads for a player that no longer exists.
   */
  onPlayingChange?: (playing: boolean) => void;
  /** Height cap for the preview surface — dialogs and panes want different ones. */
  maxHeightClassName?: string;
}

/**
 * Renders an inline video player for the formats Chromium decodes natively.
 *
 * Shared by `FilePane`, `FileBrowserViewer`, and `DiffPane` so every surface
 * plays the same files the same way — mirroring `FileImagePreview`'s role for
 * images. `useMediaBlobUrl` owns the fetch-to-blob contract this and
 * `FileAudioPreview` both depend on.
 */
export function FileVideoPreview({
  filePath,
  rootPath,
  label,
  reloadKey,
  onError,
  onPlayingChange,
  maxHeightClassName = "max-h-[70vh]",
}: FileVideoPreviewProps) {
  const { objectUrl, fetching } = useMediaBlobUrl({
    filePath,
    rootPath,
    reloadKey,
    maxBytes: VIDEO_PREVIEW_MAX_BYTES,
    tooLargeError: VIDEO_TOO_LARGE_ERROR,
    onError,
  });

  // Effect event so this keys on the source alone — callers pass inline
  // closures, and re-running on every parent render would report a stop the
  // element never made.
  const reportPlaying = useEffectEvent((playing: boolean) => onPlayingChange?.(playing));
  // Scoped to the same identity the fetch is: whatever moves the source
  // replaces the element, and the replacement starts paused.
  useEffect(() => {
    return () => reportPlaying(false);
  }, [filePath, rootPath, reloadKey]);

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
          // `paused` alone would call a buffering stall a stop; `ended` alone
          // would call a finished video still playing (the spec leaves `paused`
          // false at the end). Both, on all three events, or neither is right.
          onPlay={(event) =>
            onPlayingChange?.(!event.currentTarget.paused && !event.currentTarget.ended)
          }
          onPause={(event) =>
            onPlayingChange?.(!event.currentTarget.paused && !event.currentTarget.ended)
          }
          onEnded={(event) =>
            onPlayingChange?.(!event.currentTarget.paused && !event.currentTarget.ended)
          }
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
