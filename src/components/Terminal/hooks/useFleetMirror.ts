import { useEffect, useRef } from "react";
import type { EditorView } from "@codemirror/view";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import { useFleetArmingStore } from "@/store/fleetArmingStore";
import { useFleetResolutionPreviewStore } from "@/store/fleetResolutionPreviewStore";

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
}: UseFleetMirrorParams) {
  const isApplyingExternalValueRef = useRef(false);
  const armedIds = useFleetArmingStore((s) => s.armedIds);

  // Primary → followers: write our current draft to each other armed pane's draft slot
  useEffect(() => {
    if (!isFleetPrimary || disabled) return;
    const setDraft = useTerminalInputStore.getState().setDraftInput;
    for (const otherId of armedIds) {
      if (otherId === terminalId) continue;
      setDraft(otherId, value, projectId);
    }
    useFleetResolutionPreviewStore.getState().setDraft(value);
  }, [isFleetPrimary, value, armedIds, terminalId, projectId]);

  // Follower ← primary: pull mirrored text into our local value + editor doc
  const externalDraftKey = projectId ? `${projectId}:${terminalId}` : terminalId;
  const externalDraft = useTerminalInputStore((s) => s.draftInputs.get(externalDraftKey) ?? "");
  useEffect(() => {
    if (!isFleetFollower) return;
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
  }, [externalDraft, isFleetFollower, value]);

  // Clear resolution preview when not primary or disabled
  useEffect(() => {
    if (!isFleetPrimary || disabled) {
      useFleetResolutionPreviewStore.getState().clear();
    }
  }, [isFleetPrimary, disabled]);

  return { isApplyingExternalValueRef };
}
