import { useState } from "react";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import type { RestoreFocusTarget } from "@/components/ui/AppDialog";
import { UnsavedPanelsCallout } from "./UnsavedPanelsCallout";
import type {
  PendingProjectPluginUnload,
  ProjectPluginUnsavedGuard,
} from "./useProjectPluginUnsavedGuard";

/**
 * The Discard changes / Cancel prompt for a project plugin unload that would
 * lose unsaved work (#16656), naming the panels and their projects.
 */
export function ProjectPluginUnsavedDialog({
  guard,
  restoreFocusTo,
}: {
  guard: ProjectPluginUnsavedGuard;
  restoreFocusTo?: RestoreFocusTarget;
}) {
  const { pending } = guard;
  // The last prompt stays rendered through the exit fade instead of blanking.
  const [shown, setShown] = useState<PendingProjectPluginUnload | null>(pending);
  if (pending !== null && pending !== shown) setShown(pending);
  const unload = (pending ?? shown)?.unload;
  const panels = (pending ?? shown)?.panels ?? [];
  const mute = unload?.kind === "mute" ? unload : null;

  return (
    <ConfirmDialog
      isOpen={pending !== null}
      onClose={guard.cancel}
      title={mute ? `Turn off '${mute.displayName}'?` : "Turn off this project's plugins?"}
      description={
        mute
          ? "It unloads straight away and its open panels close. The project's other plugins keep running."
          : "Every plugin this project ships unloads straight away, and their open panels close."
      }
      confirmLabel="Discard changes"
      cancelLabel="Cancel"
      onConfirm={() => void guard.confirm()}
      variant="destructive"
      zIndex="nested"
      restoreFocusTo={restoreFocusTo}
    >
      <UnsavedPanelsCallout verb={mute ? "Turning it off" : "Turning them off"} panels={panels} />
    </ConfirmDialog>
  );
}
