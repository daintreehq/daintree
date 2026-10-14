import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { EditorView } from "@codemirror/view";
import { hasFileDrag } from "@/lib/fileDragPayload";
import { resolveTransferSources } from "@/lib/transferSources";
import { isRemoteWindow } from "@/hooks/useHostPlatform";
import { fileAttachmentEntryFromSource, insertFileAttachments } from "../fileAttachments";
import { usePanelStore } from "@/store/panelStore";
import { hasAgentContextDrag, readAgentContextDrag } from "@/lib/agentContextDragPayload";
import { draftAgentContext, getDraftRefusal } from "@/services/agentHandoff/agentDraft";
import {
  clearPaneDragOver,
  notePaneDragOver,
  resolvePaneDropTarget,
  routePaneDrop,
  usePaneDropHighlight,
} from "../uploads/paneDropRouting";
import type { TerminalFocusTarget } from "../terminalFocus";

export interface DragDropUploadOptions {
  /** Where uploads to a remote host show their progress chips. */
  uploadSurface?: string;
  /**
   * The worktree folder an Option-drop (Alt on Linux) adds files to, in a
   * remote window. Null when there is none; the drop then attaches as usual.
   */
  addToProjectDirectory?: () => string | null;
  /** The live cwd, read once the uploads land rather than when the drop happened. */
  cwdProvider?: () => string;
  /**
   * This is the pane's own input bar, so it shares file drops with the pane's
   * terminal: whichever of the two holds the keyboard takes a drop let go over
   * either. False for a composer that only borrows the terminal id (Canopy's
   * reply box), which keeps every drop let go over it.
   */
  sharesPaneDrops?: boolean;
  /**
   * Whether the bar can take a file drop now — false while it is disabled or
   * read-only, as it is while a voice submission settles. Omitted means it
   * always can.
   */
  canInsert?: () => boolean;
}

/**
 * @param onDropSelect Selects the panel that owns this input, invoked only once
 *   a drop has actually inserted something. The hook knows which *surface* was
 *   dropped on but not which panel owns it — `terminalId` is a PTY id, and the
 *   Assistant's input bar has one without being a selectable panel at all. So
 *   panel selection is delegated to the caller and simply absent where there is
 *   no panel to select.
 * @param terminalId The pane whose draft an agent-context drop lands in. Only a
 *   grid agent pane that can take a draft accepts one, so the Assistant's bar —
 *   which is no such pane — refuses it.
 */
export function useDragDrop(
  editorViewRef: React.RefObject<EditorView | null>,
  cwd: string,
  onDropSelect?: () => void,
  terminalId?: string,
  uploads: DragDropUploadOptions = {}
) {
  const {
    uploadSurface,
    addToProjectDirectory,
    cwdProvider,
    sharesPaneDrops = false,
    canInsert,
  } = uploads;
  const dragDepthRef = useRef(0);
  const paneId = sharesPaneDrops ? terminalId : undefined;
  // A bar outside any pane still tracks its own drag, under a key no pane has.
  const ownHoverKey = useId();
  const hoverKey = paneId ?? ownHoverKey;
  const [hoverOwner] = useState(() => ({}));
  const isDragOverFiles = usePaneDropHighlight(hoverKey, "hybridInput");

  // The folder an Option-drop adds files to, or null when the drop attaches
  // as usual. Read for the hover as well as the drop, so the two agree.
  const addToProjectTarget = useCallback(
    (altKey: boolean): string | null =>
      altKey && isRemoteWindow() ? (addToProjectDirectory?.() ?? null) : null,
    [addToProjectDirectory]
  );

  // Where files let go over this bar land: the terminal while it holds the
  // keyboard, and nowhere while neither surface can take them. Add to project
  // is this bar's own gesture, so it stays here whatever holds the keyboard.
  const fileDropTarget = useCallback(
    (e: React.DragEvent): TerminalFocusTarget | null => {
      const here = canInsert?.() ?? true;
      if (paneId === undefined || addToProjectTarget(e.altKey) !== null) {
        return here ? "hybridInput" : null;
      }
      const target = resolvePaneDropTarget(paneId, "hybridInput");
      return target === "hybridInput" && !here ? null : target;
    },
    [paneId, addToProjectTarget, canInsert]
  );

  useEffect(() => () => clearPaneDragOver(hoverKey, hoverOwner), [hoverKey, hoverOwner]);

  // Whether an agent-context drag would draft here. Read live at every
  // dragenter/dragover: the answer can change mid-drag (a lock, a restart),
  // and a drop target that lights up only to refuse is false feedback.
  const acceptsAgentContext = useCallback(
    () => terminalId !== undefined && getDraftRefusal(terminalId) === null,
    [terminalId]
  );

  const handleDragEnter = useCallback(
    (e: React.DragEvent) => {
      const types = e.dataTransfer.types;
      // The agent-context type wins over files at every stage, as it does at
      // drop, so the affordance never promises what the drop won't do.
      const isAgentContext = hasAgentContextDrag(types);
      const accepted = isAgentContext ? acceptsAgentContext() : hasFileDrag(types);
      if (!accepted) return;
      e.preventDefault();
      e.stopPropagation();
      dragDepthRef.current++;
      notePaneDragOver(hoverKey, hoverOwner, isAgentContext ? "hybridInput" : fileDropTarget(e));
    },
    [acceptsAgentContext, hoverKey, hoverOwner, fileDropTarget]
  );

  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      const types = e.dataTransfer.types;
      if (hasAgentContextDrag(types)) {
        // The editor is contenteditable, so left alone Chromium would accept
        // the drag's `text/plain` on its own terms. Refusing here is what makes
        // a bar that cannot take the draft say so instead of pasting raw text.
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = acceptsAgentContext() ? "copy" : "none";
        return;
      }
      if (!hasFileDrag(types)) return;
      e.preventDefault();
      e.stopPropagation();
      // Re-asked as the drag moves: either surface can lock or free up under
      // it, and Option can be pressed or released mid-drag.
      const target = fileDropTarget(e);
      e.dataTransfer.dropEffect = target === null ? "none" : "copy";
      notePaneDragOver(hoverKey, hoverOwner, target);
    },
    [acceptsAgentContext, hoverKey, hoverOwner, fileDropTarget]
  );

  const resetDragState = useCallback(() => {
    dragDepthRef.current = 0;
    clearPaneDragOver(hoverKey, hoverOwner);
  }, [hoverKey, hoverOwner]);

  const handleDragLeave = useCallback(
    (e: React.DragEvent) => {
      e.stopPropagation();
      dragDepthRef.current--;
      if (dragDepthRef.current <= 0) {
        dragDepthRef.current = 0;
        clearPaneDragOver(hoverKey, hoverOwner);
      }
    },
    [hoverKey, hoverOwner]
  );

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      resetDragState();

      // Torn down between the drag starting and the drop landing, with no
      // terminal to hand it to: nothing can take the drop.
      if (!editorViewRef.current && paneId === undefined) return;

      // A handoff from a plugin view. It goes through the same draft path as
      // `host.sendToAgent` — appended below whatever is typed, never submitted —
      // so a drag and a "Send to agent…" cannot disagree about what lands.
      // Checked before files: a drag carrying both is a plugin's, and its paths
      // (if any) are not what the user dragged.
      if (hasAgentContextDrag(e.dataTransfer.types)) {
        const view = editorViewRef.current;
        if (!view || terminalId === undefined) return;
        const payload = readAgentContextDrag(e.dataTransfer);
        if (payload === null) return;
        const result = draftAgentContext(terminalId, {
          text: payload.text,
          title: payload.title,
          sourceLabel: payload.source?.label,
        });
        if (result.status !== "drafted") return;
        // Same landing as a file drop (#11809): pane selected, keyboard in the
        // bar. The draft sync parks the caret after the block.
        usePanelStore.getState().setPreferredTerminalFocusTarget("hybridInput");
        onDropSelect?.();
        view.focus();
        return;
      }

      // Both provenances reduce to the same entry shape before anything is
      // resolved, so an in-app drag (#11576) and an OS drop cannot disagree
      // about what they insert.
      const sources = resolveTransferSources(e.dataTransfer);
      const dropped = sources.map(fileAttachmentEntryFromSource);

      if (dropped.length === 0) return;

      // Decided at the drop rather than trusted from the drag. Asked before
      // the editor is: a bar still loading can't keep the drop, but a focused
      // terminal can take it. A terminal that declines leaves the drop here,
      // where it was let go, unless the bar can't take it either.
      const target = fileDropTarget(e);
      if (target === null) return;
      if (target === "xterm" && paneId !== undefined && routePaneDrop(paneId, "xterm", sources)) {
        return;
      }
      if (canInsert && !canInsert()) return;
      const view = editorViewRef.current;
      if (!view) return;

      // Add to project is the one way a dropped file lands in the repo, and
      // only ever on purpose: Option held at the moment of the drop.
      const directory = addToProjectTarget(e.altKey);

      // The gesture already pointed at this input, so it ends the same way a
      // click on it does: pane selected, caret here, ready to type about the
      // file that just landed (#11809). A drop carrying nothing referenceable
      // returned above and leaves the selection alone.
      //
      // Committed here rather than after the insertion, because an image drop
      // waits on a thumbnail over IPC first. Selecting only once that resolved
      // would leave the keystrokes typed in between going to the pane the user
      // just navigated away from — the very bug this fixes, still present for
      // exactly the drops with the longest gap. It would also let a slow
      // thumbnail pull the selection back long after the user moved on.
      //
      // Order matters. The preference is what `TerminalPane`'s focus effect
      // reads to decide which sub-surface the newly selected pane hands the
      // keyboard to, so a stale "xterm" would yank focus straight back out.
      //
      // `view.focus()` rather than the panel focus registry: the registry
      // routes to `focusWithCursorAtEnd`, which drags the caret to the end of
      // the draft whenever the editor doesn't already hold focus — undoing the
      // caret the insertion below parks after the chip. Focusing directly keeps
      // it, and makes the pane effect's own later call a no-op, since it
      // preserves an editor that already owns DOM focus.
      usePanelStore.getState().setPreferredTerminalFocusTarget("hybridInput");
      onDropSelect?.();
      view.focus();

      await insertFileAttachments(editorViewRef, view, dropped, cwd, {
        uploadSurface,
        ...(cwdProvider ? { cwdProvider } : {}),
        ...(directory ? { destination: { kind: "worktree", directory } as const } : {}),
      });
    },
    [
      editorViewRef,
      cwd,
      onDropSelect,
      resetDragState,
      terminalId,
      uploadSurface,
      cwdProvider,
      paneId,
      fileDropTarget,
      addToProjectTarget,
      canInsert,
    ]
  );

  return {
    handleDragEnter,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    resetDragState,
    isDragOverFiles,
  };
}
