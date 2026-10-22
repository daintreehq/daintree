import { useEffect, useRef } from "react";
import {
  PREVIEW_REFUSAL_HEADER,
  isPreviewRefusal,
  type PreviewRefusal,
} from "@shared/types/ipc/files";
import { isRemoteWindow } from "@/hooks/useHostPlatform";
import { getDriveLeaseSnapshot } from "@/services/terminal/inputGate";
import { getViewWorkspaceId } from "@/store/viewWorkspaceId";
import type { MediaPreviewError } from "./useMediaSourceUrl";

/**
 * Why a remote window's host refused a preview, when it wasn't the file: the
 * host names it on the refusal. A host from before that header still answers
 * a watching view with a bare 403, and this view's lease says who drives, so
 * that pair is read the same way. Null for every other failure.
 */
export function previewRefusalOf(response: {
  status: number;
  headers?: Pick<Headers, "get">;
}): PreviewRefusal | null {
  const named = response.headers?.get(PREVIEW_REFUSAL_HEADER);
  if (isPreviewRefusal(named)) return named;
  if (response.status !== 403) return null;
  const lease = getDriveLeaseSnapshot();
  return lease !== null &&
    lease.projectId === getViewWorkspaceId() &&
    lease.holder !== null &&
    !lease.drivingHere
    ? "driven-elsewhere"
    : null;
}

/** The preview error a refusal reports, for surfaces that title their own failure. */
export function refusedPreviewError(refusal: PreviewRefusal): MediaPreviewError {
  return refusal === "driven-elsewhere"
    ? { title: "Another window has control", refusal }
    : { title: "Outside this project", refusal };
}

/**
 * Ask why a preview the element already failed to load was refused: an image
 * reports no status of its own.
 */
async function probeRefusal(url: string): Promise<PreviewRefusal | null> {
  try {
    const response = await fetch(url, { method: "HEAD" });
    return response.ok ? null : previewRefusalOf(response);
  } catch {
    return null;
  }
}

/**
 * An `<img>` error handler that reports the host's refusal when there was
 * one, and a plain failure otherwise. Only a remote window's host refuses for
 * a reason other than the file, so a local view reports at once, unprobed. A
 * probe that settles after the image moved on to another source is dropped,
 * so it can't flag the next file.
 */
export function useImageErrorHandler(
  src: string,
  onError: ((error?: MediaPreviewError) => void) | undefined
): () => void {
  const latest = useRef({ src, onError });
  useEffect(() => {
    latest.current = { src, onError };
  });
  return () => {
    if (!isRemoteWindow()) {
      onError?.();
      return;
    }
    const failedSrc = src;
    void probeRefusal(failedSrc).then((refusal) => {
      if (latest.current.src !== failedSrc) return;
      latest.current.onError?.(refusal ? refusedPreviewError(refusal) : undefined);
    });
  };
}
