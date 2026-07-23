import { useMemo } from "react";
import { buildDaintreeFileUrl } from "./filePreviewKinds";

interface FileVideoPreviewProps {
  /** Absolute path of the video being previewed. */
  filePath: string;
  /** Known root the `daintree-file://` protocol resolves the path against. */
  rootPath: string;
  /** Accessible label — the file name, so a failed video still names its file. */
  label: string;
  /**
   * Changed to force a fresh media request for the same path — the protocol
   * serves `no-store`, but the <video> element itself never re-fetches unless
   * its src changes, so a rewritten file needs a new URL to show new bytes.
   */
  reloadKey?: string | number;
  onError?: () => void;
  /** Height cap for the preview surface — dialogs and panes want different ones. */
  maxHeightClassName?: string;
}

/**
 * Renders an inline video player for the formats Chromium decodes natively.
 *
 * Shared by `FilePane`, `FileBrowserViewer`, and `DiffPane` so every surface
 * plays the same files the same way — mirroring `FileImagePreview`'s role for
 * images. The bytes stream straight from the `daintree-file://` protocol
 * (Range-aware, so seeking works without buffering the file); nothing
 * round-trips through IPC.
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

  return (
    <div className="flex items-center justify-center p-6 min-h-[300px]">
      <video
        // Keyed by src so switching files (or reloading) remounts the element
        // rather than continuing playback of the previous source.
        key={src}
        src={src}
        controls
        preload="metadata"
        aria-label={label}
        className={`max-w-full ${maxHeightClassName} rounded`}
        onError={onError}
      />
    </div>
  );
}
