import { useEffect, useId } from "react";
import type { FileEditorSlotKey, ProjectSurfaceChoice } from "@shared/types/plugin";
import { ProjectSurfaceConsentNotice } from "@/components/Plugin/ProjectSurfaceConsentNotice";
import { frameSurfaceSlot } from "@/components/Plugin/framedSurfaceSlots";

/**
 * The consent question for a project plugin's default editor (#13811), asked in
 * the file panel showing a file it covers — the place the default shows, as a
 * claimed canvas asks in its own frame. The shared notice decides whether this
 * panel is the one that asks: one plugin, one question, however many panels
 * and slots it appears in.
 */
export function FileEditorDefaultNotice({
  slot,
  onAnswered,
}: {
  slot: FileEditorSlotKey;
  onAnswered: (choice: ProjectSurfaceChoice) => void;
}) {
  const frameId = useId();
  useEffect(() => frameSurfaceSlot(slot, frameId), [slot, frameId]);
  return <ProjectSurfaceConsentNotice slot={slot} frameId={frameId} onAnswered={onAnswered} />;
}
