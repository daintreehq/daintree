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

  return (
    <ConfirmDialog
      isOpen={projectId != null}
      onClose={onClose}
      title={projectName ? `Stop '${projectName}'?` : "Stop this project?"}
      description="Every terminal and agent session running in this project is ended, and their scrollback and any in-flight agent work are lost."
      confirmLabel="Stop project"
      onConfirm={onConfirm}
      isConfirmLoading={isStopping}
      variant="destructive"
    />
  );
}
