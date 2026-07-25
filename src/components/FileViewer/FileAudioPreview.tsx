import { Skeleton, SkeletonBone, SkeletonHint } from "@/components/ui/Skeleton";
import { useMediaBlobUrl } from "./useMediaBlobUrl";
import type { MediaPreviewError } from "./useMediaBlobUrl";

// Matches the video ceiling: the blob sits in Chromium's blob storage either
// way, and an hour of 48kHz/24-bit stereo PCM lands just under 1GiB, so a
// tighter cap would reject whole-session lossless recordings for no gain.
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
  /** Known root the `daintree-file://` protocol resolves the path against. */
  rootPath: string;
  /** Accessible label — the file name, so a failed track still names its file. */
  label: string;
  /**
   * Changed to force a fresh media request for the same path — the protocol
   * serves `no-store`, but the blob is a byte-snapshot of the fetch, so a
   * rewritten file needs a new URL to show new bytes.
   */
  reloadKey?: string | number;
  /** Called when the audio can't be fetched or played; an error overrides the caller's generic copy. */
  onError?: (error?: AudioPreviewError) => void;
}

/**
 * Renders an inline audio player for the formats Chromium decodes natively.
 *
 * The audio sibling of `FileVideoPreview`, sharing its fetch-to-blob contract
 * via `useMediaBlobUrl` so both surfaces stream from `daintree-file://` the
 * same way. Deliberately has no `maxHeightClassName`: the native control is a
 * fixed-height bar, so a height cap would mean nothing.
 */
export function FileAudioPreview({
  filePath,
  rootPath,
  label,
  reloadKey,
  onError,
}: FileAudioPreviewProps) {
  const { objectUrl, fetching } = useMediaBlobUrl({
    filePath,
    rootPath,
    reloadKey,
    maxBytes: AUDIO_PREVIEW_MAX_BYTES,
    tooLargeError: AUDIO_TOO_LARGE_ERROR,
    onError,
  });

  return (
    // Chromium's native audio control drops its scrubber and volume slider
    // below ~300px, and a docked pane can be narrower than that. The floor
    // keeps the control whole and lets the wrapper scroll instead — the same
    // floor applies to the skeleton so settling doesn't shift the layout.
    <div className="flex items-center justify-center overflow-x-auto p-6">
      {objectUrl ? (
        <audio
          // Keyed by the object URL so switching files (or reloading) remounts
          // the element rather than continuing playback of the previous source.
          key={objectUrl}
          src={objectUrl}
          controls
          preload="metadata"
          aria-label={label}
          className="w-full max-w-md min-w-[300px]"
          onError={() => onError?.()}
        />
      ) : fetching ? (
        // The whole file downloads before playback starts, so a long recording
        // pushes this past the Doherty gate — a skeleton in the control's
        // shape, not a spinner. `SkeletonBone` carries the 400ms gate.
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
