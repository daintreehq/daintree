import { useEffect, useRef } from "react";
import type { EditorView } from "@codemirror/view";
import { Transaction } from "@codemirror/state";
import { clearComposerHistory } from "../inputEditorExtensions/composerHistory";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import { useFleetArmingStore } from "@/store/fleetArmingStore";
import { useFleetResolutionPreviewStore } from "@/store/fleetResolutionPreviewStore";
import { useFleetTargetOverridesStore } from "@/store/fleetTargetOverridesStore";

interface UseFleetMirrorParams {
  editorViewRef: React.RefObject<EditorView | null>;
  terminalId: string;
  projectId?: string;
  value: string;
  setValue: (value: string) => void;
  isFleetPrimary: boolean;
  isFleetFollower: boolean;
  disabled: boolean;
  lastEmittedValueRef: React.RefObject<string>;
  /** The draft the store held when the composer last wrote it or brought the editor to it (#15873). */
  syncedDraftRef: React.RefObject<string>;
  /** A second composer outside the terminal's pane: it takes no part in the fleet. */
  isolated?: boolean;
}

export function useFleetMirror({
  editorViewRef,
  terminalId,
  projectId,
  value,
  setValue,
  isFleetPrimary,
  isFleetFollower,
  disabled,
  lastEmittedValueRef,
  syncedDraftRef,
  isolated = false,
}: UseFleetMirrorParams) {
  const isApplyingExternalValueRef = useRef(false);
  const armedIds = useFleetArmingStore((s) => s.armedIds);

  // Primary → followers: write our current draft to each other armed pane's
  // draft slot, holding each one's own draft the first time it's replaced.
  useEffect(() => {
    if (isolated || !isFleetPrimary || disabled) return;
    // The fleet as it is now, not as it rendered: a fleet cleared since would
    // otherwise get this draft, and holds nothing is left to release.
    const liveArmedIds = useFleetArmingStore.getState().armedIds;
    if (!liveArmedIds.has(terminalId) || liveArmedIds.size < 2) return;
    useTerminalInputStore.getState().mirrorFleetDraft(terminalId, value, liveArmedIds, projectId);
    useFleetResolutionPreviewStore.getState().setDraft(value);
  }, [isFleetPrimary, value, armedIds, terminalId, projectId, isolated]);

  // Follower ← primary: pull mirrored text into our local value + editor doc
  const externalDraftKey = projectId ? `${projectId}:${terminalId}` : terminalId;
  const externalDraft = useTerminalInputStore((s) => s.draftInputs.get(externalDraftKey) ?? "");
  useEffect(() => {
    if (isolated || !isFleetFollower) return;
    if (externalDraft === value) return;
    lastEmittedValueRef.current = externalDraft;
    syncedDraftRef.current = externalDraft;
    setValue(externalDraft);
    const view = editorViewRef.current;
    if (view && view.state.doc.toString() !== externalDraft) {
      isApplyingExternalValueRef.current = true;
      // The primary's keystrokes, not this pane's: its undo stays with it,
      // and this pane's older steps would replay deleted text into the
      // mirror (an undone deletion survives a whole-text replace).
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: externalDraft },
        annotations: Transaction.addToHistory.of(false),
      });
      clearComposerHistory(view);
    }
  }, [externalDraft, isFleetFollower, value, isolated]);

  // Leaving the fleet: the draft store has this pane's own draft back.
  const holdsOwnDraft = useTerminalInputStore(
    (s) => typeof s.fleetDraftHolds.get(externalDraftKey)?.draft === "string"
  );
  const heldOwnDraftRef = useRef(holdsOwnDraft);
  useEffect(() => {
    const wasHeld = heldOwnDraftRef.current;
    heldOwnDraftRef.current = holdsOwnDraft;
    if (isolated || holdsOwnDraft || !wasHeld) return;
    const draft = useTerminalInputStore.getState().draftInputs.get(externalDraftKey) ?? "";
    lastEmittedValueRef.current = draft;
    syncedDraftRef.current = draft;
    setValue(draft);
    const view = editorViewRef.current;
    if (!view) return;
    if (view.state.doc.toString() !== draft) {
      isApplyingExternalValueRef.current = true;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: draft },
        annotations: Transaction.addToHistory.of(false),
      });
    }
    // Every step since it was held edited the fleet's draft, not this one.
    clearComposerHistory(view);
  }, [
    holdsOwnDraft,
    externalDraftKey,
    isolated,
    editorViewRef,
    lastEmittedValueRef,
    syncedDraftRef,
    setValue,
  ]);

  // Clear resolution preview when not primary or disabled. Per-target
  // overrides (#8691) ride alongside — they're ephemeral per-broadcast and
  // shouldn't survive disarm or focus moves to a non-primary pane.
  // An isolated composer never owned them, so it never clears the fleet's.
  useEffect(() => {
    if (isolated) return;
    if (!isFleetPrimary || disabled) {
      useFleetResolutionPreviewStore.getState().clear();
      useFleetTargetOverridesStore.getState().clear();
    }
  }, [isFleetPrimary, disabled, isolated]);

  return { isApplyingExternalValueRef };
}
