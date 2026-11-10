import { useMemo } from "react";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { pluralize } from "@/lib/pluralize";
import { useProjectStatsStore } from "@/store/projectStatsStore";
import { useProjectStore } from "@/store/projectStore";

interface StopProjectConfirmDialogProps {
  /** The project whose sessions would be stopped; the dialog is open while set. */
  projectId: string | null | undefined;
  isStopping: boolean;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
}

// Outside the component: the compiler rejects a store hook referenced as a value inside one.
function readStopCounts(projectId: string | null | undefined) {
  if (projectId == null) return null;
  const entry = useProjectStatsStore.getState().stats[projectId];
  if (!entry) return null;
  return {
    terminals: entry.processCount,
    active: entry.activeAgentCount,
    waiting: entry.waitingAgentCount,
  };
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

  // Read once when the dialog opens, so the figures don't shift under the cursor.
  const counts = useMemo(() => readStopCounts(projectId), [projectId]);
  const hasCounts =
    counts != null && (counts.terminals > 0 || counts.active > 0 || counts.waiting > 0);

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
    >
      {hasCounts && (
        <div data-stop-counts="" className="mt-3 text-sm">
          {counts.terminals > 0 && <div>• {pluralize(counts.terminals, "terminal")}</div>}
          {counts.active > 0 && <div>• {pluralize(counts.active, "active agent")}</div>}
          {counts.waiting > 0 && <div>• {pluralize(counts.waiting, "waiting agent")}</div>}
        </div>
      )}
    </ConfirmDialog>
  );
}
