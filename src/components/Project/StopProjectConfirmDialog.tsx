import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useProjectStore } from "@/store/projectStore";

interface StopProjectConfirmDialogProps {
  /** The project whose sessions would be stopped; the dialog is open while set. */
  projectId: string | null | undefined;
  isStopping: boolean;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
}

/**
 * The one confirm for stopping a project's sessions. The toolbar switcher and
 * the modal palette each hold their own `useProjectSwitcherPalette`, so each
 * renders this — one definition, so the two can't drift apart in copy.
 */
export function StopProjectConfirmDialog({
  projectId,
  isStopping,
  onClose,
  onConfirm,
}: StopProjectConfirmDialogProps) {
  const projectName = useProjectStore((state) =>
    projectId ? state.projects.find((project) => project.id === projectId)?.name : undefined
  );
  const isActiveProject = useProjectStore(
    (state) => projectId != null && state.currentProject?.id === projectId
  );

  return (
    <ConfirmDialog
      isOpen={projectId != null}
      onClose={onClose}
      title={projectName ? `Stop '${projectName}'?` : "Stop this project?"}
      description={
        isActiveProject
          ? "Every terminal in this project is ended, shells and dev servers as well as agent sessions, and their scrollback and any in-flight agent work are lost. This window then leaves the project and returns to the project screen."
          : "Every terminal in this project is ended, shells and dev servers as well as agent sessions, and their scrollback and any in-flight agent work are lost."
      }
      confirmLabel="Stop project"
      onConfirm={onConfirm}
      isConfirmLoading={isStopping}
      variant="destructive"
    />
  );
}
