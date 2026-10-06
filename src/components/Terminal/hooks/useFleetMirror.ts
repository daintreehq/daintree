import { useEffect, useRef } from "react";
import type { EditorView } from "@codemirror/view";
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
  isolated = false,
}: UseFleetMirrorParams) {
  const isApplyingExternalValueRef = useRef(false);
  const armedIds = useFleetArmingStore((s) => s.armedIds);

  // Primary → followers: write our current draft to each other armed pane's draft slot
  useEffect(() => {
    if (isolated || !isFleetPrimary || disabled) return;
    const setDraft = useTerminalInputStore.getState().setDraftInput;
    for (const otherId of armedIds) {
      if (otherId === terminalId) continue;
      setDraft(otherId, value, projectId);
    }
    useFleetResolutionPreviewStore.getState().setDraft(value);
  }, [isFleetPrimary, value, armedIds, terminalId, projectId, isolated]);

  // Follower ← primary: pull mirrored text into our local value + editor doc
  const externalDraftKey = projectId ? `${projectId}:${terminalId}` : terminalId;
  const externalDraft = useTerminalInputStore((s) => s.draftInputs.get(externalDraftKey) ?? "");
  useEffect(() => {
    if (isolated || !isFleetFollower) return;
    if (externalDraft === value) return;
    lastEmittedValueRef.current = externalDraft;
    setValue(externalDraft);
    const view = editorViewRef.current;
    if (view && view.state.doc.toString() !== externalDraft) {
      isApplyingExternalValueRef.current = true;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: externalDraft },
      });
    }
  }, [externalDraft, isFleetFollower, value, isolated]);

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
