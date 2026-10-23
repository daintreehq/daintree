import { useEffect, useId } from "react";
import {
  projectSurfaceSlotDescriptor,
  type FileEditorSlotKey,
  type ProjectSurfaceChoice,
} from "@shared/types/plugin";
import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
import { ProjectSurfaceConsentNotice } from "@/components/Plugin/ProjectSurfaceConsentNotice";
import { frameSurfaceSlot } from "@/components/Plugin/framedSurfaceSlots";
import {
  selectFailedSave,
  usePluginProjectSurfacesStore,
} from "@/store/pluginProjectSurfacesStore";

/** Whether main recorded the answer about `slot` — a failed save leaves it unanswered. */
function recorded(slot: FileEditorSlotKey): boolean {
  return selectFailedSave(usePluginProjectSurfacesStore.getState(), slot) === null;
}

/**
 * The consent question for a project plugin's default editor (#13811), asked in
 * the file panel showing a file it covers — the place the default shows, as a
 * claimed canvas asks in its own frame. The shared notice decides whether this
 * panel is the one that asks: one plugin, one question, however many panels
 * and slots it appears in.
 *
 * `onAnswered` hears only an answer main recorded. One that failed to save
 * leaves the default unanswered, so the pane keeps what it shows and says why,
 * with a retry — the same row a framed slot draws.
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
  const failedSave = usePluginProjectSurfacesStore((s) => selectFailedSave(s, slot));
  const setSurfaceChoices = usePluginProjectSurfacesStore((s) => s.setSurfaceChoices);
  const dismissFailedSave = usePluginProjectSurfacesStore((s) => s.dismissFailedSave);

  if (failedSave !== null) {
    const choice = failedSave.updates.find((update) => update.slot === slot)?.choice ?? null;
    const retry = async () => {
      await setSurfaceChoices(failedSave.updates);
      if (choice !== null && recorded(slot)) onAnswered(choice);
    };
    return (
      <InlineStatusBanner
        title={`Couldn't save the ${projectSurfaceSlotDescriptor(slot).noun} choice`}
        severity="error"
        role="alert"
        action={{ id: "retry", label: "Retry", variant: "primary", onClick: () => void retry() }}
        onClose={dismissFailedSave}
      />
    );
  }
  return (
    <ProjectSurfaceConsentNotice
      slot={slot}
      frameId={frameId}
      onAnswered={(choice) => {
        if (recorded(slot)) onAnswered(choice);
      }}
    />
  );
}
