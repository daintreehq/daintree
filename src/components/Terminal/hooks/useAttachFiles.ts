import { useCallback, useRef } from "react";
import type { RefObject } from "react";
import type { EditorView } from "@codemirror/view";
import { logError } from "@/utils/logger";
import { currentHostId } from "@/hooks/useHostPlatform";
import { pickHostPaths } from "@/components/HostFilePicker/hostFilePickerQueue";
import { fileAttachmentEntryFromPath, insertFileAttachments } from "../fileAttachments";

/**
 * The attach button: opens the native file picker and inserts whatever the user
 * chose exactly as if it had been dropped on the composer — image thumbnails
 * where a preview is allowed, `@file` tokens for everything else.
 *
 * Pane selection needs nothing here. The button sits inside the input bar's
 * root, whose own click handling already selects the pane and focuses the
 * editor before the picker opens.
 */
export function useAttachFiles(
  editorViewRef: RefObject<EditorView | null>,
  cwd: string,
  uploadSurface?: string
) {
  // The picker is modal when it has a parent window, but it opens unparented
  // when none can be resolved, and then nothing stops a second click from
  // stacking another one.
  const inFlightRef = useRef(false);

  return useCallback(async () => {
    const view = editorViewRef.current;
    if (!view || inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const filePaths = await window.electron.clipboard.pickAttachments();
      if (filePaths.length === 0) return;
      // The dialog can stay open across a remount or a session switch, and the
      // selection was made for the draft the user was looking at when they
      // clicked, not whichever one replaced it.
      if (editorViewRef.current !== view) return;
      // Already focused by the click in the common case; this covers a picker
      // that handed focus back somewhere else. Direct rather than through the
      // focus registry so the caret the insertion parks after the chips stays.
      view.focus();
      await insertFileAttachments(
        editorViewRef,
        view,
        filePaths.map((filePath) => fileAttachmentEntryFromPath(filePath, "local")),
        cwd,
        uploadSurface === undefined ? {} : { uploadSurface }
      );
    } catch (error) {
      logError("[HybridInputBar] Attachment picker failed", error);
    } finally {
      inFlightRef.current = false;
    }
  }, [editorViewRef, cwd, uploadSurface]);
}

/**
 * The attach menu's host leg in a remote window: Daintree's picker over the
 * host, whose choices are host paths already, so nothing is transferred.
 */
export function useAttachFromHost(editorViewRef: RefObject<EditorView | null>, cwd: string) {
  const inFlightRef = useRef(false);

  return useCallback(async () => {
    const view = editorViewRef.current;
    if (!view || inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const paths = await pickHostPaths({
        mode: "file",
        multiple: true,
        title: "Attach files",
        buttonLabel: "Attach",
        ...(cwd ? { defaultPath: cwd } : {}),
      });
      if (!paths || paths.length === 0) return;
      if (editorViewRef.current !== view) return;
      view.focus();
      const hostId = currentHostId();
      await insertFileAttachments(
        editorViewRef,
        view,
        paths.map((filePath) => ({ ...fileAttachmentEntryFromPath(filePath, "host"), hostId })),
        cwd
      );
    } catch (error) {
      logError("[HybridInputBar] Host attachment picker failed", error);
    } finally {
      inFlightRef.current = false;
    }
  }, [editorViewRef, cwd]);
}
