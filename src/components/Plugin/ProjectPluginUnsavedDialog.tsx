import { useState } from "react";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import type { RestoreFocusTarget } from "@/components/ui/AppDialog";
import { UnsavedPanelsCallout } from "./UnsavedPanelsCallout";
import type {
  PendingProjectPluginUnload,
  ProjectPluginUnload,
  ProjectPluginUnsavedGuard,
} from "./useProjectPluginUnsavedGuard";

function copyFor(unload: ProjectPluginUnload | undefined): { title: string; description: string } {
  switch (unload?.kind) {
    case "mute":
      return {
        title: `Turn off '${unload.displayName}'?`,
        description:
          "It unloads straight away and its open panels close. The project's other plugins keep running.",
      };
    case "instanceOff":
      return {
        title: `Turn off '${unload.displayName}' in this project?`,
        description:
          "This project's copy unloads straight away and its open panels close. Copies running in other projects aren't affected.",
      };
    default:
      return {
        title: "Turn off this project's plugins?",
        description:
          "Every plugin this project ships unloads straight away, and their open panels close.",
      };
  }
}

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
  const { title, description } = copyFor(unload);

  return (
    <ConfirmDialog
      isOpen={pending !== null}
      onClose={guard.cancel}
      title={title}
      description={description}
      confirmLabel="Discard changes"
      cancelLabel="Cancel"
      onConfirm={() => void guard.confirm()}
      variant="destructive"
      zIndex="nested"
      restoreFocusTo={restoreFocusTo}
    >
      <UnsavedPanelsCallout
        verb={
          unload === undefined || unload.kind === "trustOff" ? "Turning them off" : "Turning it off"
        }
        panels={panels}
      />
    </ConfirmDialog>
  );
}
