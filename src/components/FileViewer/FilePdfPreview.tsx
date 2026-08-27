import { useMemo } from "react";
import { buildDaintreePdfUrl } from "./filePreviewKinds";

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
 * 3. A direct `src`, not a blob. `FileVideoPreview` detours through a Blob
 *    object URL to dodge the single-shot custom-scheme media loader, but
 *    PDFium won't accept a `blob:` navigation — it needs a real URL serving
 *    `application/pdf`, which is exactly what this scheme is for.
 */
export function FilePdfPreview({ filePath, rootPath, label, reloadKey }: FilePdfPreviewProps) {
  const src = useMemo(() => {
    const url = buildDaintreePdfUrl(filePath, rootPath);
    // Cache-busting query param only — the protocol handler ignores it.
    // Null-checked, not truthiness: a numeric key of 0 is a valid value.
    return reloadKey != null ? `${url}&v=${encodeURIComponent(reloadKey)}` : url;
  }, [filePath, rootPath, reloadKey]);

  return (
    <iframe
      // Empty string, never {true}: React omits an unknown attribute given a
      // boolean value, which would silently drop the credentialless behavior
      // the COEP shell depends on.
      credentialless=""
      src={src}
      title={label}
      referrerPolicy="no-referrer"
      className="h-full w-full border-0 bg-surface-canvas"
    />
  );
}
