import { useEffect, useEffectEvent, useRef } from "react";
import { Skeleton, SkeletonBone, SkeletonHint } from "@/components/ui/Skeleton";
import { useMediaSourceUrl } from "./useMediaSourceUrl";
import type { MediaPreviewError } from "./useMediaSourceUrl";

// Playback streams byte ranges now, so this no longer bounds anything held in
// memory. It survives as a preview-scope judgement: past ~1GiB a file is a
// deliverable rather than something to skim in a pane, and the viewer says so
// plainly instead of scrubbing a multi-hour recording through a docked panel.
// A 4K screen recording runs ~10MB/min, so this clears an hour either way.
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
  /** Known root the media protocol resolves the path against. */
  rootPath: string;
  /** Accessible label — the file name, so a failed video still names its file. */
  label: string;
  /**
   * Changed to force a fresh media request for the same path. The protocol
   * serves `no-store`, but the element holds the buffered bytes of the source
   * it is already playing, so a rewritten file needs a new URL.
   */
  reloadKey?: string | number;
  /** Called when the video can't be fetched or played; an error overrides the caller's generic copy. */
  onError?: (error?: VideoPreviewError) => void;
  /**
   * Reports whether this preview is mid-playback, so an owner that would
   * otherwise move `reloadKey` can hold off (#12165). Always taken back on
   * unmount or a source change: a fresh element starts paused and fires no
   * `pause` of its own, so an owner left holding the last `true` would suppress
   * reloads for a player that no longer exists. That retraction goes to
   * whichever handler is committed at the time, so the callback must belong to
   * one stable owner rather than being swapped between independent recipients.
   * Each call is a snapshot rather than a transition — the same value may
   * arrive twice (an error retracts, then the unmount retracts again).
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
 * images. `useMediaSourceUrl` owns the size-cap and error contract this and
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
  const { sourceUrl, probing } = useMediaSourceUrl({
    filePath,
    rootPath,
    reloadKey,
    maxBytes: VIDEO_PREVIEW_MAX_BYTES,
    tooLargeError: VIDEO_TOO_LARGE_ERROR,
    onError,
  });

  const mediaRef = useRef<HTMLVideoElement>(null);

  // Effect event so this keys on the source alone — callers pass inline
  // closures, and re-running on every parent render would report a stop the
  // element never made.
  const reportPlaying = useEffectEvent((playing: boolean) => onPlayingChange?.(playing));
  // Scoped to the same identity the probe is: whatever moves the source
  // replaces the element, and the replacement starts paused.
  useEffect(() => {
    return () => reportPlaying(false);
  }, [filePath, rootPath, reloadKey]);

  // Detaching the source is what actually stops an in-flight range request.
  // Unmounting the node alone leaves Chromium's media loader pulling bytes
  // until the element is collected — and "closed the pane after two seconds"
  // is precisely the case direct streaming exists to make cheap. The element
  // is captured in the effect body, not read from the ref in the cleanup: a
  // `key` change swaps the ref to the new node before cleanup runs, so reading
  // it there would release the element that just took over.
  useEffect(() => {
    const element = mediaRef.current;
    if (!element) return;
    return () => {
      element.pause();
      element.removeAttribute("src");
      element.load();
    };
  }, [sourceUrl]);

  return (
    <div className="flex items-center justify-center p-6 min-h-[300px]">
      {sourceUrl ? (
        <video
          // Keyed by the source URL so switching files (or reloading) remounts
          // the element rather than continuing playback of the previous source.
          key={sourceUrl}
          ref={mediaRef}
          src={sourceUrl}
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
          // A decode failure stops playback without a `pause`. Every caller in
          // tree unmounts the preview here, which would retract it anyway — but
          // the leaf is shared, and one that merely logs must not be left
          // holding a player that stopped.
          onError={() => {
            onPlayingChange?.(false);
            onError?.();
          }}
        />
      ) : probing ? (
        // Only the size probe stands between mount and playback now — a single
        // HEAD answered from an fd stat, so this is normally imperceptible and
        // `SkeletonBone`'s 400ms gate swallows it. It still earns its place on a
        // cold or contended disk, where the stat is the one thing that stalls.
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
