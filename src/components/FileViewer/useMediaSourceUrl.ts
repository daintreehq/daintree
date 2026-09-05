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
 * The element's `src` points at the protocol and the media loader requests byte
 * ranges as it needs them, rather than this hook reading the file whole. That
 * rests on `daintree-media://` being registered `standard: true`: the upstream
 * report behind the old blob detour (electron/electron#51442) closed when its
 * author traced the single-shot behaviour to a registration missing that flag.
 * How many ranges a start actually costs, and whether a seek issues one at all
 * rather than reading buffered data, are measurements — not claims to make
 * here. `npm run test:e2e:mechanism` is what answers them.
 *
 * The cap is applied by a `HEAD` on `daintree-file://` rather than on the media
 * scheme itself. That scheme already carries the `supportFetchAPI`/`corsEnabled`
 * privileges and the `connect-src` allowance a `fetch()` needs, and its media
 * branch answers HEAD from an fd stat without reading the file, so the media
 * scheme stays minimal — no fetch surface at all, since tag loads are no-cors
 * and never consult it. The probe doubles as the error surface: a missing or
 * uncontained file fails here with a readable status, before the element is
 * ever mounted.
 *
 * The cap is admission-time only. It is measured on the file the probe saw, and
 * the stream that follows is a separate open — a file that grows past the
 * ceiling in between is still served. That was acceptable to leave as is:
 * nothing is buffered whole any more, so an over-cap file costs ranges rather
 * than a gigabyte of blob storage.
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
