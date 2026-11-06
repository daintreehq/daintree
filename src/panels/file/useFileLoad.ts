import { useCallback, useEffect, useRef, useState } from "react";
import type { FileReadErrorCode, FileTextEncoding } from "@shared/types/ipc/files";
import { sanitizeSvgForPreview } from "@/lib/svg";
import { isHtmlFilePath } from "@/components/Html/isHtmlFile";
import { refusalReason } from "@/components/FileViewer/FileUnavailableState";
import type { MediaPreviewError } from "@/components/FileViewer/useMediaSourceUrl";
import {
  isAudioFilePath,
  isImageFilePath,
  isPdfFilePath,
  isSvgFilePath,
  isUnsupportedAudioFilePath,
  isUnsupportedVideoFilePath,
  isVideoFilePath,
  UNSUPPORTED_AUDIO_MESSAGE,
  UNSUPPORTED_VIDEO_MESSAGE,
} from "@/components/FileViewer/filePreviewKinds";
import { toFileReadErrorCode } from "@/components/FileViewer/fileReadErrors";
import { filesClient } from "@/clients/filesClient";
import { isClientAppError } from "@/utils/clientAppError";

// "image", "svg", "video", "audio", and "pdf" are terminal preview states: an
// image is handed to the `daintree-file://` protocol as an <img> src, an SVG is
// read as text, sanitized, then inlined, video/audio are fetched from the same
// protocol into a blob the media element plays, and a PDF is framed from
// `daintree-pdf://` into Chromium's built-in viewer. None has readable text
// content.
export type LoadState =
  "idle" | "loading" | "loaded" | "error" | "image" | "svg" | "video" | "audio" | "pdf";

// Why a read is happening, which decides two things a single boolean used to
// conflate. `explicit` is a gesture aimed at this pane (open, toolbar Refresh,
// Retry): it earns the loading skeleton and re-requests every rendered surface.
// `ambient` is the filesystem talking (change tick, focus regain): it must not
// flash the skeleton, and must not move a reload key an unrelated write would
// otherwise use to reset playback. `revealed` is returning to this project:
// silent like ambient, because nobody asked for a skeleton, but forcing the
// reload key like explicit, because everything that happened while the view sat
// cached is precisely what this pane cannot otherwise see — with one exception,
// a player already running, whose position outranks bytes nobody asked for
// (#12165).
export type FileLoadIntent = "explicit" | "ambient" | "revealed";

/**
 * What the pane's error state keeps: a read's code, or a remote host's
 * refusal of a preview, which is about control or location and not the file.
 */
export type FilePaneErrorCode = FileReadErrorCode | "DRIVEN_ELSEWHERE" | "OUTSIDE_PROJECT";

export function previewErrorCode(
  error: MediaPreviewError | undefined,
  fallback: FileReadErrorCode
): FilePaneErrorCode {
  const refused = refusalReason(error);
  if (refused === "DRIVEN_ELSEWHERE" || refused === "OUTSIDE_PROJECT") return refused;
  return error?.code ?? fallback;
}

export interface FileByteFacts {
  encoding?: FileTextEncoding;
  byteLength?: number;
}

export interface FileLoad {
  content: string | null;
  /** `content` as the source view draws it: without the BOM the strip already names. */
  sourceText: string | null;
  loadState: LoadState;
  sanitizedSvg: string | null;
  errorCode: FilePaneErrorCode | null;
  errorMessage: string | null;
  htmlPreviewUrl: string | null;
  reloadNonce: number;
  byteFacts: FileByteFacts;
  canonicalFilePath: string | null;
  loadFile: (intent: FileLoadIntent) => void;
  handleMediaPlayingChange: (playing: boolean) => void;
  /**
   * A rendered preview failed after the read settled — an image that won't
   * decode, a codec the player lacks. `message` left out keeps the current one.
   */
  failPreview: (code: FilePaneErrorCode, message?: string) => void;
}

/**
 * Reads the file at `filePath` through `effectiveRootPath` and owns everything
 * that read decides: the content and its byte facts, which preview state the
 * pane is in, the last good view a silent refresh may fall back to, and the
 * reload key for every surface whose content lives behind a URL. A change of
 * either input is a new identity: the next load invalidates any read still in
 * flight, and the last good view of the old file is forgotten. The caller
 * decides when to load — on a new identity, an explicit `loadFile("explicit")`.
 */
export function useFileLoad(filePath: string | undefined, effectiveRootPath: string): FileLoad {
  const [content, setContent] = useState<string | null>(null);
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [sanitizedSvg, setSanitizedSvg] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<FilePaneErrorCode | null>(null);
  // Overrides the code-derived copy for failures that no `FileReadErrorCode`
  // describes (a readable file whose SVG content the sanitizer rejects).
  // Mirrors FileViewerModal's `displayErrorMessage`.
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // Sandboxed-iframe preview URL for HTML files (#11191), minted by files:read.
  const [htmlPreviewUrl, setHtmlPreviewUrl] = useState<string | null>(null);
  // Reload generation for every surface whose content lives behind a URL rather
  // than in React state: the sandboxed HTML preview frame, the media players,
  // and the raster <img>. Their URLs are pure functions of path and root, so
  // without a changing token a rewritten file is never re-requested. Bumped on
  // every successful load, not just entry-file changes, so relative assets stay
  // fresh too. Never a `loadFile` dependency — that would re-trigger the load.
  const [reloadNonce, setReloadNonce] = useState(0);
  // Whether the media preview on screen is mid-playback. A ref, not state: the
  // only reader is `loadFile`, which runs as an event and would rather not be
  // re-created (and re-run its effects) every time someone presses play. The
  // preview takes its own `true` back on unmount or a source change, so a set
  // flag always names the player currently on screen (#12165).
  const mediaPlayingRef = useRef(false);
  const handleMediaPlayingChange = useCallback((playing: boolean) => {
    mediaPlayingRef.current = playing;
  }, []);

  // What `files:read` observed about the bytes behind `content` — set with it,
  // so the strip never pairs one read's text with another read's encoding.
  const [byteFacts, setByteFacts] = useState<FileByteFacts>({});
  // The strip names a BOM, so the source view needn't draw it: CodeMirror
  // paints U+FEFF as a special-character dot ahead of the first token, the
  // one mark the editor's own decode already strips. Display only — copying
  // the file still copies its bytes.
  const sourceText =
    content !== null && byteFacts.encoding === "utf-8-bom" && content.charCodeAt(0) === 0xfeff
      ? content.slice(1)
      : content;
  const requestRef = useRef(0);
  // The state the last good view of the *current* file settled into, or null if
  // there has not been one. A silent refresh may only swallow a failure when
  // there is good content to preserve, and swallowing has to restore this
  // rather than merely return: the silent read may have superseded an explicit
  // one that already switched the pane to its skeleton, and nothing else is
  // left to settle it. Reset per identity — the previous file's content is not
  // something worth keeping.
  const lastGoodStateRef = useRef<LoadState | null>(null);
  // The text currently on screen for the *current* identity, so a silent re-read
  // can tell an actual rewrite from a tick that changed nothing. Reset per
  // identity alongside the state above.
  const lastContentRef = useRef<string | null>(null);
  // The file whose last read came back through its own realpath — the only
  // spelling the watcher's directories can be matched against.
  const [canonicalFilePath, setCanonicalFilePath] = useState<string | null>(null);
  useEffect(() => {
    lastGoodStateRef.current = null;
    lastContentRef.current = null;
  }, [filePath, effectiveRootPath]);

  const loadFile = useCallback(
    (intent: FileLoadIntent) => {
      // Two independent questions, and reveal answers them differently from
      // either of the other intents. Whether to show the skeleton: only an
      // explicit gesture earns one, because only then is someone waiting on a
      // surface they just asked for. Whether to re-request the rendered
      // surface: everything but an ambient pass, so returning to a project
      // moves the reload key that a background tick deliberately leaves alone.
      const silent = intent !== "explicit";
      const forceSurfaceReload = intent !== "ambient";
      // Reveal is the one intent that can arrive while someone is listening: it
      // is not a request for fresh bytes, it is this pane catching up on a
      // project it was away from. A track mid-play is worth more than a
      // re-fetch, so it keeps its key and the next Refresh pulls the rewrite
      // instead (#12165). Explicit gestures still outrank playback.
      const keepMediaPlaying = intent === "revealed" && mediaPlayingRef.current;
      if (!filePath) {
        requestRef.current += 1;
        setContent(null);
        setLoadState("idle");
        setErrorCode(null);
        return;
      }
      requestRef.current += 1;
      const requestId = requestRef.current;
      if (!silent) {
        setLoadState("loading");
        setErrorCode(null);
        setErrorMessage(null);
      }

      // Raster images are served straight to an <img> by the protocol handler —
      // reading them as text would just hit the binary-file guard.
      if (isImageFilePath(filePath) && !isSvgFilePath(filePath)) {
        setContent(null);
        setSanitizedSvg(null);
        // Unconditionally, unlike the media branches below: a still image has no
        // playback or reader position to protect, so a silent background pass
        // should show the new bytes rather than preserve the old ones. Without
        // this the <img> URL never changes and even toolbar Refresh is inert.
        setReloadNonce((nonce) => nonce + 1);
        setLoadState("image");
        setErrorCode(null);
        setErrorMessage(null);
        return;
      }

      // Videos stream from the protocol handler into a <video> element; the
      // text path would reject them with a misleading size/binary error.
      if (isVideoFilePath(filePath)) {
        setContent(null);
        setSanitizedSvg(null);
        // Only a foreground load (open, toolbar Refresh, returning to this
        // project) re-requests the media — an ambient background pass must not
        // remount the player and reset playback while someone is watching, and
        // neither may a reveal that finds the player already running.
        if (forceSurfaceReload && !keepMediaPlaying) setReloadNonce((nonce) => nonce + 1);
        setLoadState("video");
        setErrorCode(null);
        setErrorMessage(null);
        return;
      }

      // Audio takes the same protocol-to-blob route as video — the text path
      // would reject it with a misleading size/binary error.
      if (isAudioFilePath(filePath)) {
        setContent(null);
        setSanitizedSvg(null);
        // Only a foreground load (open, toolbar Refresh, returning to this
        // project) re-requests the media — an ambient background pass must not
        // remount the player and reset playback while someone is listening, and
        // neither may a reveal that finds the player already running.
        if (forceSurfaceReload && !keepMediaPlaying) setReloadNonce((nonce) => nonce + 1);
        setLoadState("audio");
        setErrorCode(null);
        setErrorMessage(null);
        return;
      }

      // PDFs are framed straight from the protocol handler into Chromium's
      // built-in viewer; the text path would reject them as a binary file.
      if (isPdfFilePath(filePath)) {
        setContent(null);
        setSanitizedSvg(null);
        // Only a foreground load (open, toolbar Refresh, returning to this
        // project) re-requests the document — an ambient background pass must
        // not remount the frame and throw away the reader's page and zoom.
        if (forceSurfaceReload) setReloadNonce((nonce) => nonce + 1);
        setLoadState("pdf");
        setErrorCode(null);
        setErrorMessage(null);
        return;
      }

      // Formats Chromium can't decode get a truthful "can't play" message
      // instead of falling through to the text path's size cap.
      const unsupportedMediaMessage = isUnsupportedVideoFilePath(filePath)
        ? UNSUPPORTED_VIDEO_MESSAGE
        : isUnsupportedAudioFilePath(filePath)
          ? UNSUPPORTED_AUDIO_MESSAGE
          : null;
      if (unsupportedMediaMessage) {
        setContent(null);
        setSanitizedSvg(null);
        setErrorCode("BINARY_FILE");
        setErrorMessage(unsupportedMediaMessage);
        setLoadState("error");
        return;
      }

      // Nothing may skip a tick on the strength of a read that is still being
      // repeated: the answer this one brings back is the one that counts.
      setCanonicalFilePath(null);
      filesClient
        .read({
          path: filePath,
          rootPath: effectiveRootPath,
          htmlPreview: isHtmlFilePath(filePath),
        })
        .then(
          ({
            content: fileContent,
            htmlPreviewUrl: previewUrl,
            pathIsCanonical,
            encoding,
            byteLength,
          }) => {
            if (requestRef.current !== requestId) return;
            setCanonicalFilePath(pathIsCanonical === true ? filePath : null);
            // SVG is text on disk but a picture on screen: sanitize it and check
            // it parses before it is drawn, and surface a rejection as a load
            // error rather than silently rendering nothing.
            if (isSvgFilePath(filePath)) {
              const sanitized = sanitizeSvgForPreview(fileContent);
              if (sanitized.ok) {
                setSanitizedSvg(sanitized.svg);
                setContent(null);
                setLoadState("svg");
                setErrorCode(null);
                setErrorMessage(null);
                lastGoodStateRef.current = "svg";
              } else if (silent && lastGoodStateRef.current !== null) {
                // Still a failed read, however the pane looks: keep taking every
                // tick until one lands.
                setCanonicalFilePath(null);
                // A background pass catching a half-written file mid-save reads
                // as a rejection, so keep the last good drawing rather
                // than replacing it — the same bargain the text path's transient
                // -failure guard below makes.
                setLoadState(lastGoodStateRef.current);
              } else {
                // The file read fine; its contents just can't be drawn safely.
                setErrorCode("INVALID_PATH");
                setErrorMessage(sanitized.error);
                setLoadState("error");
              }
              return;
            }
            setSanitizedSvg(null);
            const bytesChanged = lastContentRef.current !== fileContent;
            lastContentRef.current = fileContent;
            setContent((previous) => (previous === fileContent ? previous : fileContent));
            setByteFacts((previous) =>
              previous.encoding === encoding && previous.byteLength === byteLength
                ? previous
                : { encoding, byteLength }
            );
            setHtmlPreviewUrl(previewUrl ?? null);
            // Re-navigate the preview frame so a rewritten report — or an unchanged
            // entry file whose relative asset changed — reflects the latest bytes.
            // The nonce is the sandboxed frame's only src input, so an ambient
            // pass only bumps it when the bytes actually moved: otherwise every
            // worktree tick, most of them writes to unrelated files, would throw
            // away the rendered page's scroll and in-page JS state. Foreground
            // loads (open, toolbar Refresh, returning to this project) stay
            // unconditional — an entry file whose relative asset was rewritten
            // while the project sat cached reads as unchanged bytes, so the
            // bytes-changed gate is exactly what would leave it stale.
            // reloadNonce isn't a loadFile dep, so neither can re-trigger the
            // load.
            //
            // Markdown takes the same gate. Its embedded images are the
            // "unchanged file whose asset changed" case (#11587), but they no
            // longer hang off this nonce: each one refreshes on the ticks that
            // could have touched its own file (#15678).
            if (forceSurfaceReload || bytesChanged) {
              setReloadNonce((nonce) => nonce + 1);
            }
            setLoadState("loaded");
            setErrorCode(null);
            setErrorMessage(null);
            lastGoodStateRef.current = "loaded";
          }
        )
        .catch((error: unknown) => {
          if (requestRef.current !== requestId) return;
          const code = isClientAppError(error) ? toFileReadErrorCode(error.code) : "INVALID_PATH";
          // Silent background refreshes keep showing the last good content on
          // transient failures, but a permanently-gone file (deleted, perms
          // revoked) must surface rather than display stale text forever.
          // Only worth swallowing when there is good content to keep — and it
          // has to be restored rather than merely left alone: this read may
          // have superseded an explicit one that already showed the skeleton,
          // in which case nothing else would ever settle it.
          const permanent =
            code === "NOT_FOUND" || code === "PERMISSION" || code === "OUTSIDE_ROOT";
          // A swallowed failure still leaves the reset canonical flag above
          // cleared, so every tick keeps retrying while the last good content
          // stays on screen.
          if (silent && !permanent && lastGoodStateRef.current !== null) {
            setLoadState(lastGoodStateRef.current);
            return;
          }
          setErrorCode(code);
          setErrorMessage(null);
          setLoadState("error");
        });
    },
    [filePath, effectiveRootPath]
  );

  const failPreview = useCallback((code: FilePaneErrorCode, message?: string) => {
    setErrorCode(code);
    if (message !== undefined) setErrorMessage(message);
    setLoadState("error");
  }, []);

  return {
    content,
    sourceText,
    loadState,
    sanitizedSvg,
    errorCode,
    errorMessage,
    htmlPreviewUrl,
    reloadNonce,
    byteFacts,
    canonicalFilePath,
    loadFile,
    handleMediaPlayingChange,
    failPreview,
  };
}
