import { useEffect, useEffectEvent, useRef } from "react";
import { Skeleton, SkeletonBone, SkeletonHint } from "@/components/ui/Skeleton";
import { useMediaSourceUrl } from "./useMediaSourceUrl";
import type { MediaPreviewError } from "./useMediaSourceUrl";

// Matches the video ceiling. The hook no longer builds a whole-file Blob, so
// this is a preview-scope judgement rather than a memory bound — and an hour of
// 48kHz 24-bit stereo PCM lands just under 1GiB, so a tighter cap would reject
// whole-session lossless recordings for no gain.
const AUDIO_PREVIEW_MAX_BYTES = 1024 * 1024 * 1024;

/** Why a preview couldn't play, split so callers can render a headline and a way forward. */
export type AudioPreviewError = MediaPreviewError;

const AUDIO_TOO_LARGE_ERROR: MediaPreviewError = {
  title: "This audio file is too large to preview",
  description: "Open it outside Daintree to listen to it.",
  code: "FILE_TOO_LARGE",
};

interface FileAudioPreviewProps {
  /** Absolute path of the audio file being previewed. */
  filePath: string;
  /** Known root the media protocol resolves the path against. */
  rootPath: string;
  /** Accessible label — the file name, so a failed track still names its file. */
  label: string;
  /**
   * Changed to force a fresh media request for the same path. The protocol
   * serves `no-store`, but the element holds the buffered bytes of the source
   * it is already playing, so a rewritten file needs a new URL.
   */
  reloadKey?: string | number;
  /** Called when the audio can't be fetched or played; an error overrides the caller's generic copy. */
  onError?: (error?: AudioPreviewError) => void;
  /**
   * Reports whether this preview is mid-track, so an owner that would otherwise
   * move `reloadKey` can hold off (#12165). Always taken back on unmount or a
   * source change: a fresh element starts paused and fires no `pause` of its
   * own, so an owner left holding the last `true` would suppress reloads for a
   * player that no longer exists. That retraction goes to whichever handler is
   * committed at the time, so the callback must belong to one stable owner
   * rather than being swapped between independent recipients.
   * Each call is a snapshot rather than a transition — the same value may
   * arrive twice (an error retracts, then the unmount retracts again).
   */
  onPlayingChange?: (playing: boolean) => void;
}

/**
 * Renders an inline audio player for the formats Chromium decodes natively.
 *
 * The audio sibling of `FileVideoPreview`, sharing its size-cap and error
 * contract via `useMediaSourceUrl` so both surfaces stream from
 * `daintree-media://` the same way. Deliberately has no `maxHeightClassName`:
 * the native control is a fixed-height bar, so a height cap would mean nothing.
 */
export function FileAudioPreview({
  filePath,
  rootPath,
  label,
  reloadKey,
  onError,
  onPlayingChange,
}: FileAudioPreviewProps) {
  const { sourceUrl, probing } = useMediaSourceUrl({
    filePath,
    rootPath,
    reloadKey,
    maxBytes: AUDIO_PREVIEW_MAX_BYTES,
    tooLargeError: AUDIO_TOO_LARGE_ERROR,
    onError,
  });

  const mediaRef = useRef<HTMLAudioElement>(null);

  // Effect event so this keys on the source alone — callers pass inline
  // closures, and re-running on every parent render would report a stop the
  // element never made.
  const reportPlaying = useEffectEvent((playing: boolean) => onPlayingChange?.(playing));
  // Scoped to the same identity the probe is: whatever moves the source
  // replaces the element, and the replacement starts paused.
  useEffect(() => {
    return () => reportPlaying(false);
  }, [filePath, rootPath, reloadKey]);

  // Reset the element rather than trusting the node's removal to end its
  // requests: the hook's AbortController governs the size probe only, and
  // nothing else here would tell the media loader to stop. "Closed the pane
  // after two seconds" is precisely the case this exists for. The element
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
    // Chromium's native audio control drops its scrubber and volume slider
    // below ~300px, and a docked pane can be narrower than that. The floor
    // keeps the control whole and lets the wrapper scroll instead — the same
    // floor applies to the skeleton so settling doesn't shift the layout.
    <div className="flex items-center justify-center overflow-x-auto p-6">
      {sourceUrl ? (
        <audio
          // Keyed by the source URL so switching files (or reloading) remounts
          // the element rather than continuing playback of the previous source.
          key={sourceUrl}
          ref={mediaRef}
          src={sourceUrl}
          controls
          preload="metadata"
          aria-label={label}
          className="w-full max-w-md min-w-[300px]"
          // `paused` alone would call a buffering stall a stop; `ended` alone
          // would call a finished track still playing (the spec leaves `paused`
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
        // Covers the size probe — a HEAD answered from a realpath and an fd
        // stat, so `SkeletonBone`'s 400ms gate normally swallows it entirely. It
        // earns its place on a cold or contended disk. The mounted control still
        // loads its own metadata afterwards; that wait is the element's.
        <div className="flex w-full max-w-md min-w-[300px] flex-col items-center gap-3">
          <Skeleton label="Loading audio" className="w-full">
            <SkeletonBone className="h-[54px] w-full rounded-full" />
          </Skeleton>
          {/* Sibling, never nested: the wrapper's aria-busy silences mutations
              inside its own subtree. */}
          <SkeletonHint />
        </div>
      ) : null}
    </div>
  );
}
