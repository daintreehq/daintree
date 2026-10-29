import { ExternalLink, Globe, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FolderOpen } from "@/components/icons";
import { getFileTypeIcon } from "@/panels/file-browser/fileTypeIcons";
import {
  FileUnavailableState,
  unavailableCopy,
  type RemoteFileContext,
  type UnavailableReason,
} from "@/components/FileViewer/FileUnavailableState";
import { ControlRefusedState, SaveHostFileButton } from "@/components/FileViewer/hostFileActions";
import {
  isAudioFilePath,
  isImageFilePath,
  isPdfFilePath,
  isSvgFilePath,
  isUnsupportedAudioFilePath,
  isUnsupportedVideoFilePath,
  isVideoFilePath,
} from "@/components/FileViewer/filePreviewKinds";
import type { FilePaneErrorCode } from "./useFileLoad";
import type { ExternalTarget } from "./useFileExternalOpen";

/**
 * The structured reason behind the pane's error state, recovered from the
 * code and message it already keeps. The pane stores a read-error code even
 * for failures no read produced — an image that won't decode, a codec the
 * player lacks — so the file's kind decides which of those it really was.
 */
function toUnavailableReason(
  filePath: string,
  code: FilePaneErrorCode,
  message: string | null
): UnavailableReason {
  // A host refusal is about control or location, never the file: it outranks
  // whatever the file's kind would otherwise make of a failure.
  if (code === "DRIVEN_ELSEWHERE" || code === "OUTSIDE_PROJECT") return code;
  if (isUnsupportedVideoFilePath(filePath) || isUnsupportedAudioFilePath(filePath)) {
    return "UNSUPPORTED_MEDIA";
  }
  // Previews before the size code: a PDF or a video refused as too large is a
  // preview limit with the OS app as its way out, not text for the editor.
  if (isPdfFilePath(filePath)) return "PDF_FAILED";
  if (isVideoFilePath(filePath) || isAudioFilePath(filePath)) return "MEDIA_FAILED";
  if (code === "FILE_TOO_LARGE") return "FILE_TOO_LARGE";
  // An SVG is read like text, so its read failures keep their own codes; only
  // a sanitizer rejection (a read that succeeded) is the SVG's own reason.
  if (isSvgFilePath(filePath)) {
    return code === "INVALID_PATH" && message !== null ? "SVG_REJECTED" : code;
  }
  // A raster image never goes through a read; its only failure is a decode.
  if (isImageFilePath(filePath)) return "IMAGE_FAILED";
  return code;
}

/**
 * Failures a second attempt can't change: a directory never becomes a file, an
 * unsupported container never becomes playable, and a binary never becomes
 * text. Everything else keeps Retry — a permission can clear, a decode can
 * succeed once a half-written file settles, a refused PDF can come back.
 */
const NOT_RETRYABLE: ReadonlySet<UnavailableReason> = new Set<UnavailableReason>([
  "NOT_A_FILE",
  "UNSUPPORTED_MEDIA",
  "BINARY_FILE",
  "OUTSIDE_PROJECT",
  // Reloads by itself once this window has control (useRetryOnControl).
  "DRIVEN_ELSEWHERE",
]);

/**
 * The file panel's unavailable body: the same cause-first wording as the file
 * browser's (`FileUnavailableState`), wired to this pane's own handlers. The
 * cause's own way out comes first. "Open" follows the file's kind — the editor
 * for oversized text, the OS default app for media, images and PDFs, but only
 * inside a governed root where that open is contained; outside one, Reveal,
 * which carries a guarded out-of-root fallback, takes its place. A PDF always
 * keeps Reveal beside its open, since a link out of the root passes the lexical
 * check and fails the OS one. Retry follows for anything a retry can fix.
 */
export function FilePaneUnavailable({
  errorCode,
  errorMessage,
  filePath,
  fileName,
  revealLabel,
  openTarget,
  canOpenInDefaultApp,
  remote,
  onRetry,
  onExternal,
}: {
  errorCode: FilePaneErrorCode;
  errorMessage: string | null;
  filePath: string;
  fileName: string;
  revealLabel: string;
  openTarget: "browser" | "editor";
  canOpenInDefaultApp: boolean;
  remote: RemoteFileContext | null;
  onRetry: () => void;
  onExternal: (target: ExternalTarget) => void;
}) {
  const reason = toUnavailableReason(filePath, errorCode, errorMessage);
  if (reason === "DRIVEN_ELSEWHERE") {
    return (
      <ControlRefusedState
        icon={getFileTypeIcon(fileName).Icon}
        what="The file"
        data-testid="file-pane-unavailable"
      />
    );
  }
  const shared = unavailableCopy(reason, errorMessage ?? "", remote);
  // Refreshing this pane can't turn a folder into something it can show; the
  // file manager can.
  const copy =
    reason === "NOT_A_FILE"
      ? { ...shared, description: "It can't be opened here. Reveal it to see what's inside." }
      : shared;
  const isPreviewLimit =
    reason === "UNSUPPORTED_MEDIA" ||
    reason === "MEDIA_FAILED" ||
    reason === "IMAGE_FAILED" ||
    reason === "PDF_FAILED";
  const openVia: ExternalTarget | null =
    copy.action !== "open"
      ? null
      : isPreviewLimit
        ? canOpenInDefaultApp
          ? "default-app"
          : null
        : openTarget;
  const offersReveal =
    copy.action === "reveal" ||
    reason === "NOT_A_FILE" ||
    reason === "PDF_FAILED" ||
    (copy.action === "open" && openVia === null);
  const offersRetry = !NOT_RETRYABLE.has(reason);

  return (
    <FileUnavailableState
      icon={getFileTypeIcon(fileName).Icon}
      title={copy.title}
      description={copy.description}
      data-testid="file-pane-unavailable"
      action={
        <div className="flex flex-wrap items-center justify-center gap-2">
          {copy.action === "save" && <SaveHostFileButton hostPath={filePath} />}
          {openVia !== null && (
            <Button variant="subtle" size="sm" onClick={() => onExternal(openVia)}>
              {openVia === "browser" ? <Globe /> : <ExternalLink />}
              {openVia === "default-app"
                ? "Open in default app"
                : openVia === "browser"
                  ? "Open in browser"
                  : "Open in editor"}
            </Button>
          )}
          {offersReveal && (
            <Button variant="subtle" size="sm" onClick={() => onExternal("reveal")}>
              <FolderOpen />
              {revealLabel}
            </Button>
          )}
          {offersRetry && (
            <Button variant="subtle" size="sm" onClick={onRetry}>
              <RefreshCw />
              Retry
            </Button>
          )}
        </div>
      }
    />
  );
}
