import { ErrorBoundary } from "@/components/ErrorBoundary";
import { Callout } from "@/components/ui/Callout";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { pluralize } from "@/lib/pluralize";
import {
  useProjectSleepConfirmStore,
  type SleepConfirmProject,
} from "@/store/projectSleepConfirmStore";

/** Rounded, because the reading is an estimate and a precise figure would claim otherwise. */
export function formatEstimatedMemory(memoryMB: number): string {
  if (memoryMB >= 1024) return `${(memoryMB / 1024).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(memoryMB))} MB`;
}

function ProjectRow({
  project,
  showMemory,
}: {
  project: SleepConfirmProject;
  showMemory: boolean;
}) {
  return (
    <li>
      <div className="flex items-baseline justify-between gap-3">
        <div className="min-w-0 truncate text-sm font-medium">{project.name}</div>
        {showMemory && (
          <div
            data-sleep-project-memory=""
            className="shrink-0 text-xs text-text-secondary"
            title="Estimated from process memory. Processes share pages, so the RAM actually freed is lower."
          >
            {project.terminalMemoryMB === undefined
              ? "Memory unavailable"
              : `About ${formatEstimatedMemory(project.terminalMemoryMB)}`}
          </div>
        )}
      </div>
      <div className="mt-1 font-mono text-xs text-text-secondary">{project.path}</div>
    </li>
  );
}

function ProjectSleepConfirmDialogInner() {
  const pending = useProjectSleepConfirmStore((s) => s.pendingConfirm);
  const resolveConfirmation = useProjectSleepConfirmStore((s) => s.resolveConfirmation);
  if (!pending) return null;

  const { projects, kind } = pending.request;
  const single = projects.length === 1;
  const terminalCount = projects.reduce((sum, p) => sum + p.terminalCount, 0);
  const activeAgentCount = projects.reduce((sum, p) => sum + p.activeAgentCount, 0);
  const waitingAgentCount = projects.reduce((sum, p) => sum + p.waitingAgentCount, 0);
  const showMemory = kind === "idle";
  const readings = projects.flatMap((p) =>
    p.terminalMemoryMB === undefined ? [] : [p.terminalMemoryMB]
  );
  const totalMB = readings.reduce((sum, mb) => sum + mb, 0);

  return (
    <ConfirmDialog
      isOpen={true}
      onClose={() => resolveConfirmation(false)}
      title={
        single
          ? `Sleep '${projects[0]!.name}'?`
          : `Sleep ${pluralize(projects.length, kind === "idle" ? "idle project" : "project")}?`
      }
      confirmLabel={single ? "Sleep project" : "Sleep projects"}
      cancelLabel="Cancel"
      onConfirm={() => resolveConfirmation(true)}
      variant="default"
    >
      <div className="space-y-3">
        <ul data-sleep-projects="" className="space-y-2">
          {projects.map((project) => (
            <ProjectRow key={project.id} project={project} showMemory={showMemory} />
          ))}
        </ul>
        {(kind === "idle" ||
          terminalCount > 0 ||
          activeAgentCount > 0 ||
          waitingAgentCount > 0) && (
          <Callout
            severity="warning"
            title={single ? "Its terminals will be stopped" : "Their terminals will be stopped"}
          >
            <div>
              {terminalCount > 0 && <div>• {pluralize(terminalCount, "terminal")}</div>}
              {activeAgentCount > 0 && <div>• {pluralize(activeAgentCount, "active agent")}</div>}
              {waitingAgentCount > 0 && (
                <div>• {pluralize(waitingAgentCount, "waiting agent")}</div>
              )}
            </div>
          </Callout>
        )}
        {showMemory && readings.length > 0 && (
          <div data-sleep-memory-total="" className="text-xs text-text-secondary">
            Up to {formatEstimatedMemory(totalMB)} of terminal memory, estimated. Processes share
            pages, so the memory actually freed is lower.
          </div>
        )}
        {projects.some((p) => p.isActive) && (
          <div className="text-xs text-text-secondary">
            This window returns to the project picker
          </div>
        )}
        <div className="text-xs text-text-secondary">
          The layout, terminal scrollback, and agent sessions come back when you reopen{" "}
          {single ? "the project" : "each project"}.
        </div>
      </div>
    </ConfirmDialog>
  );
}

/**
 * Host for the sleep confirmation `project.sleep` and `project.sleepIdle` await.
 * Mounted app-wide: the palette closes on pick and the memory notice clears on
 * recovery, so a dialog owned by either would unmount under the request.
 */
export function ProjectSleepConfirmDialog() {
  const requestSeq = useProjectSleepConfirmStore((s) => s.requestSeq);
  return (
    <ErrorBoundary
      variant="component"
      componentName="ProjectSleepConfirmDialog"
      resetKeys={[requestSeq]}
    >
      <ProjectSleepConfirmDialogInner />
    </ErrorBoundary>
  );
}
