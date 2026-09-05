import { useEffect, useEffectEvent, useMemo, useState } from "react";
import type { FileReadErrorCode } from "@shared/types/ipc/files";
import { buildDaintreeFileUrl, buildDaintreeMediaUrl } from "./filePreviewKinds";

/** Why a preview couldn't play, split so callers can render a headline and a way forward. */
export interface MediaPreviewError {
  /** Names what happened. Callers with a titled error surface use it as the title. */
  title: string;
  /** Second line naming the next action. */
  description?: string;
  /** Read-error code for panes that gate their error surface on one. */
  code?: FileReadErrorCode;
}

interface UseMediaSourceUrlOptions {
  /** Absolute path of the media being previewed. */
  filePath: string;
  /** Known root both protocols resolve the path against. */
  rootPath: string;
  /**
   * Changed to force a fresh media request for the same path. The protocol
   * serves `no-store`, but a media element holds the buffered bytes of the
   * source it is already playing, so a rewritten file needs a new URL.
   */
  reloadKey?: string | number;
  /** Ceiling for a single preview, enforced against the declared length. */
  maxBytes: number;
  /** Reported instead of the generic failure when the file exceeds `maxBytes`. */
  tooLargeError: MediaPreviewError;
  /** Called when the media can't be served; an error overrides the caller's generic copy. */
  onError?: (error?: MediaPreviewError) => void;
}

/**
 * Resolves a `daintree-media://` URL for a media element to stream directly.
 *
 * Shared by `FileVideoPreview` and `FileAudioPreview` so the size cap, abort
 * sequencing and error surface have exactly one owner — the parts that are easy
 * to get subtly wrong and impossible to notice when they drift.
 *
 * The element's `src` points at the protocol, and Chromium's media loader pulls
 * byte ranges as it needs them: a few megabytes to start playing, and a fresh
 * range on every seek. That only works because `daintree-media://` is registered
 * `standard: true`. Without it the loader consumes one response and never
 * re-requests, which is why this hook used to fetch the whole file into a Blob —
 * the missing privilege, not a Chromium limit, is what killed every mp4 whose
 * `moov` atom trails its payload (electron/electron#51442, closed once the
 * reporter isolated the flag). Confirming that against this build needs a real
 * media pipeline: `npm run test:e2e:mechanism`.
 *
 * The cap is enforced by a `HEAD` on `daintree-file://` rather than on the media
 * scheme itself. That scheme already carries the `supportFetchAPI`/`corsEnabled`
 * privileges and the `connect-src` allowance a `fetch()` needs, and answers HEAD
 * from an fd stat without reading a byte, so the media scheme stays minimal —
 * no fetch surface at all, since tag loads are no-cors and never consult it.
 * The probe doubles as the error surface: a missing or uncontained file fails
 * here with a readable status, before the element is ever mounted.
 */
export function useMediaSourceUrl({
  filePath,
  rootPath,
  reloadKey,
  maxBytes,
  tooLargeError,
  onError,
}: UseMediaSourceUrlOptions): { sourceUrl: string | null; probing: boolean } {
  const { probeUrl, mediaUrl } = useMemo(() => {
    // Cache-busting query param only — both protocol handlers ignore it.
    // Null-checked, not truthiness: a numeric key of 0 is a valid value.
    const bust = reloadKey != null ? `&v=${encodeURIComponent(reloadKey)}` : "";
    return {
      probeUrl: `${buildDaintreeFileUrl(filePath, rootPath)}${bust}`,
      mediaUrl: `${buildDaintreeMediaUrl(filePath, rootPath)}${bust}`,
    };
  }, [filePath, rootPath, reloadKey]);

  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [probing, setProbing] = useState(true);

  // Effect events so the probe effect keys on the URLs and cap alone (all
  // stable) — callers pass inline closures, and re-probing on every parent
  // render would restart playback each time anything else in the pane changes.
  const reportError = useEffectEvent(() => onError?.());
  const reportTooLarge = useEffectEvent(() => onError?.(tooLargeError));

  useEffect(() => {
    const controller = new AbortController();
    setProbing(true);
    setSourceUrl(null);

    void fetch(probeUrl, { method: "HEAD", signal: controller.signal })
      .then((response) => {
        // Guarded before any state write: an already-settled fetch promise can
        // run this reaction after cleanup aborted it, and reporting then would
        // clear the skeleton / flag an error on the file shown NEXT.
        if (controller.signal.aborted) return;
        if (!response.ok) throw new Error(`daintree-file responded ${response.status}`);
        const declared = response.headers.get("content-length");
        // An absent or unparseable length can't be measured against the cap.
        // Play it anyway: nothing is buffered whole any more, so an unknown
        // size costs a few ranges rather than a gigabyte of blob storage.
        const declaredLength = declared === null ? null : Number(declared);
        if (
          declaredLength !== null &&
          Number.isFinite(declaredLength) &&
          declaredLength > maxBytes
        ) {
          setProbing(false);
          reportTooLarge();
          return;
        }
        setSourceUrl(mediaUrl);
        setProbing(false);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setProbing(false);
        reportError();
      });

    return () => controller.abort();
  }, [probeUrl, mediaUrl, maxBytes]);

  return { sourceUrl, probing };
}
