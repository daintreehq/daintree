import { useCallback, useRef } from "react";
import type { RefObject } from "react";
import type { EditorView } from "@codemirror/view";
import { logError } from "@/utils/logger";
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
export function useAttachFiles(editorViewRef: RefObject<EditorView | null>, cwd: string) {
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
        cwd
      );
    } catch (error) {
      logError("[HybridInputBar] Attachment picker failed", error);
    } finally {
      inFlightRef.current = false;
    }
  }, [editorViewRef, cwd]);
}
