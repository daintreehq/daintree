import { useEffect, useEffectEvent, useMemo, useState } from "react";
import { Skeleton, SkeletonBone, SkeletonHint } from "@/components/ui/Skeleton";
import { buildDaintreePdfUrl } from "./filePreviewKinds";
import type { MediaPreviewError } from "./useMediaSourceUrl";

/** Why a PDF couldn't be framed, split so callers can render a headline and a way forward. */
export type PdfPreviewError = MediaPreviewError;

// Anything the handler doesn't name — a 400, a 500, or a probe the network
// layer refused outright — gets this, never silence.
const PDF_UNAVAILABLE_ERROR: PdfPreviewError = {
  title: "This PDF couldn't be displayed",
  description: "Refresh to try again, or open it in your default app.",
};

// Keyed by the statuses the daintree-pdf:// handler actually answers with. A
// 404 covers both a missing file and one whose canonical path escapes the root
// — the handler deliberately doesn't say which — so the copy names both, and
// it carries no read-error code that would claim one of them.
const PDF_ERRORS_BY_STATUS: ReadonlyMap<number, PdfPreviewError> = new Map<number, PdfPreviewError>(
  [
    [
      404,
      {
        title: "This PDF couldn't be found",
        description: "It may have moved, or it resolves outside the folder being viewed.",
      },
    ],
    [
      413,
      {
        title: "This PDF is too large to preview",
        description: "Open it in your default app to read it.",
        code: "FILE_TOO_LARGE",
      },
    ],
    [
      415,
      {
        title: "This file isn't a PDF",
        description: "Its name ends in .pdf, but it links to a file of another type.",
      },
    ],
  ]
);

interface FilePdfPreviewProps {
  /** Absolute path of the PDF being previewed. */
  filePath: string;
  /** Known root the `daintree-pdf://` protocol resolves the path against. */
  rootPath: string;
  /** Accessible name for the frame — the file name, so the document names its file. */
  label: string;
  /**
   * Changed to force a fresh document request for the same path. The protocol
   * serves `no-store`, but the frame won't re-navigate to an identical URL on
   * its own, so an explicit refresh needs a new one.
   */
  reloadKey?: string | number;
  /**
   * Called with the reason when the document can't be served. The preview then
   * renders nothing, so the caller owns the error surface.
   */
  onError?: (error: PdfPreviewError) => void;
}

/**
 * Renders a PDF inline using Chromium's built-in PDFium viewer.
 *
 * Shared by `FilePane`, `FileBrowserViewer`, and `DiffPane` so every surface
 * previews PDFs the same way — mirroring `FileImagePreview`/`FileVideoPreview`.
 *
 * Three details are load-bearing, all verified against Electron 42 /
 * Chromium 148:
 *
 * 1. `credentialless`. The app shell is COEP `credentialless`, and such a
 *    document may only embed a frame that asserts COEP itself — but a PDF
 *    response carrying COEP makes the PDF an embedder whose own internal
 *    viewer frame is then blocked (ERR_BLOCKED_BY_RESPONSE). The
 *    `credentialless` attribute resolves the deadlock: the frame loads in an
 *    ephemeral context, so the embedded document needs no COEP at all.
 * 2. No `sandbox`. Unlike the `daintree-html://` preview, sandboxing kills
 *    PDFium outright (ERR_BLOCKED_BY_CLIENT) — it needs same-origin
 *    postMessage with the viewer frame it installs. Isolation comes from the
 *    scheme instead: `daintree-pdf://` only ever emits `application/pdf`.
 * 3. A direct `src`, not a blob. PDFium won't accept a `blob:` navigation — it
 *    needs a real URL serving `application/pdf`, which is exactly what this
 *    scheme is for.
 *
 * The frame is only mounted once a `HEAD` on the same URL has answered 200
 * (#12598). An iframe reports no status — its `error` event never fires and
 * `load` fires for an error page too — so without the probe a missing,
 * oversized or non-PDF target paints an empty box with nothing to say why.
 * Like the media probe, this is admission-time only: a file rewritten between
 * the probe and the navigation is served, or refused, by the handler alone.
 */
export function FilePdfPreview({
  filePath,
  rootPath,
  label,
  reloadKey,
  onError,
}: FilePdfPreviewProps) {
  const documentUrl = useMemo(() => buildDaintreePdfUrl(filePath, rootPath), [filePath, rootPath]);
  // Cache-busting query param only — the protocol handler ignores it.
  // Null-checked, not truthiness: a numeric key of 0 is a valid value.
  const src = reloadKey != null ? `${documentUrl}&v=${encodeURIComponent(reloadKey)}` : documentUrl;

  // The URL the frame is allowed to show, and the document it belongs to.
  const [admitted, setAdmitted] = useState<{ documentUrl: string; src: string } | null>(null);
  const [probing, setProbing] = useState(true);

  // An effect event so the probe keys on the URL alone — callers pass inline
  // closures, and re-probing on every parent render would re-navigate the frame
  // and throw away the reader's page and zoom.
  const reportError = useEffectEvent((error: PdfPreviewError) => onError?.(error));

  useEffect(() => {
    const controller = new AbortController();
    setProbing(true);
    // A refresh of the same document keeps its frame until the new URL is
    // admitted, so the reload re-navigates that frame in place rather than
    // remounting it. A different document must never linger in the meantime.
    setAdmitted((current) => (current?.documentUrl === documentUrl ? current : null));

    void fetch(src, { method: "HEAD", signal: controller.signal })
      .then((response) => {
        // Guarded before any state write: an already-settled fetch can run this
        // reaction after cleanup aborted it, and reporting then would flag an
        // error on the file shown NEXT.
        if (controller.signal.aborted) return;
        setProbing(false);
        if (!response.ok) {
          setAdmitted(null);
          reportError(PDF_ERRORS_BY_STATUS.get(response.status) ?? PDF_UNAVAILABLE_ERROR);
          return;
        }
        setAdmitted({ documentUrl, src });
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setProbing(false);
        setAdmitted(null);
        reportError(PDF_UNAVAILABLE_ERROR);
      });

    return () => controller.abort();
  }, [documentUrl, src]);

  // Gated on the document at render time, not left to the effect: the render
  // that first sees a new file commits before its probe starts, and would
  // otherwise show the previous file's frame under the new file's name.
  const frameSrc = admitted?.documentUrl === documentUrl ? admitted.src : null;

  if (frameSrc !== null) {
    return (
      <iframe
        // Empty string, never {true}: React omits an unknown attribute given a
        // boolean value, which would silently drop the credentialless behavior
        // the COEP shell depends on.
        credentialless=""
        src={frameSrc}
        title={label}
        referrerPolicy="no-referrer"
        className="h-full w-full border-0 bg-surface-canvas"
      />
    );
  }

  // Settled with nothing admitted: the caller owns the error surface. A stale
  // admission instead means this document's probe hasn't started — loading.
  if (!probing && admitted === null) return null;

  return (
    // The probe is a realpath and a stat, so `SkeletonBone`'s 400ms gate
    // normally swallows it; it earns its place on a cold or contended disk.
    <div className="flex h-full w-full flex-col gap-3 p-4">
      <Skeleton label="Loading PDF" className="min-h-0 flex-1">
        <SkeletonBone className="h-full w-full" />
      </Skeleton>
      {/* Sibling, never nested: the wrapper's aria-busy silences mutations
          inside its own subtree. */}
      <SkeletonHint />
    </div>
  );
}
