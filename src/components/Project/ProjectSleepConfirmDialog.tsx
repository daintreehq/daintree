import { useId, useState } from "react";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { Callout } from "@/components/ui/Callout";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import {
  CHOICE_LABEL_INSET,
  CHOICE_SELECTED,
  CHOICE_SHELL,
  CHOICE_UNSELECTED,
  RadioChoiceGroup,
  RadioChoiceRow,
} from "@/components/ui/RadioChoice";
import { cn } from "@/lib/utils";
import { pluralize } from "@/lib/pluralize";
import { SLEEP_PAUSE_NOTE } from "@/services/projectSleepWait";
import {
  useProjectSleepConfirmStore,
  type SleepChoice,
  type SleepConfirmProject,
  type SleepConfirmRequest,
} from "@/store/projectSleepConfirmStore";
import { ProjectSleepWaitDialog } from "./ProjectSleepWaitDialog";

/** Rounded, because the reading is an estimate and a precise figure would claim otherwise. */
export function formatEstimatedMemory(memoryMB: number): string {
  if (memoryMB >= 1024) return `${(memoryMB / 1024).toFixed(1)} GB`;
  return `${Math.round(memoryMB)} MB`;
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

function StoppedCounts({ project }: { project: SleepConfirmProject }) {
  return (
    <div>
      {project.terminalCount > 0 && <div>• {pluralize(project.terminalCount, "terminal")}</div>}
      {project.activeAgentCount > 0 && (
        <div>• {pluralize(project.activeAgentCount, "active agent")}</div>
      )}
      {project.waitingAgentCount > 0 && (
        <div>• {pluralize(project.waitingAgentCount, "waiting agent")}</div>
      )}
    </div>
  );
}

/**
 * A restart always stops whatever the project is running, so the warning is
 * shown even when the counts are zero or couldn't be read, and it names both
 * halves of the bundled operation: the stop and the reopen.
 */
function RestartConfirm({
  project,
  onConfirm,
  onCancel,
}: {
  project: SleepConfirmProject;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <ConfirmDialog
      isOpen={true}
      onClose={onCancel}
      title={`Restart '${project.name}'?`}
      confirmLabel="Restart project"
      cancelLabel="Cancel"
      onConfirm={onConfirm}
      variant="default"
    >
      <div className="space-y-3">
        <ul data-sleep-projects="" className="space-y-2">
          <ProjectRow project={project} showMemory={false} />
        </ul>
        <Callout severity="warning" title="Everything running in it will be stopped">
          <StoppedCounts project={project} />
        </Callout>
        <div className="text-xs text-text-secondary">
          It reopens in this window with its layout, terminal scrollback, and agent sessions. Other
          windows showing it return to the project picker. Other projects keep running.
        </div>
      </div>
    </ConfirmDialog>
  );
}

/**
 * Sleep now, or once every agent is observed settled (#17882). The pause note
 * is off by default and only means something for the wait, so it sits under
 * that choice and is disabled with it.
 */
function WhenToSleepChoice({
  when,
  pauseNote,
  onWhen,
  onPauseNote,
}: {
  when: SleepChoice["when"];
  pauseNote: boolean;
  onWhen: (when: SleepChoice["when"]) => void;
  onPauseNote: (pauseNote: boolean) => void;
}) {
  const noteId = useId();
  const noteDetailsId = useId();
  return (
    <RadioChoiceGroup legend="When to sleep" legendHidden>
      <RadioChoiceRow
        name="sleep-when"
        value="now"
        checked={when === "now"}
        onChange={() => onWhen("now")}
        label="Sleep now"
        description="Stops every terminal and agent right away, wherever it is"
      />
      <div className={cn(CHOICE_SHELL, when === "idle" ? CHOICE_SELECTED : CHOICE_UNSELECTED)}>
        <RadioChoiceRow
          bare
          name="sleep-when"
          value="idle"
          checked={when === "idle"}
          onChange={() => onWhen("idle")}
          label="Sleep when agents are idle"
          description="Waits until every agent is observed idle or at its prompt. An agent waiting on an approval or a question holds it open."
        />
        <div className={cn("flex items-start gap-2 px-3 pb-2.5", CHOICE_LABEL_INSET)}>
          <Checkbox
            id={noteId}
            className="mt-0.5 shrink-0"
            checked={pauseNote}
            disabled={when !== "idle"}
            onCheckedChange={(checked) => onPauseNote(checked === true)}
            aria-describedby={noteDetailsId}
            data-sleep-pause-note=""
          />
          <div className="min-w-0">
            <label
              htmlFor={noteId}
              className={cn(
                "block text-sm text-text-primary",
                when === "idle" ? "cursor-pointer" : "cursor-not-allowed"
              )}
            >
              Ask working agents to pause
            </label>
            <div id={noteDetailsId} className="text-xs text-text-secondary">
              Sends “{SLEEP_PAUSE_NOTE}” once to each agent observed working
            </div>
          </div>
        </div>
      </div>
    </RadioChoiceGroup>
  );
}

function SleepConfirm({
  request,
  onChoose,
}: {
  request: SleepConfirmRequest;
  onChoose: (choice: SleepChoice | null) => void;
}) {
  const [when, setWhen] = useState<SleepChoice["when"]>("now");
  const [pauseNote, setPauseNote] = useState(false);
  const { projects, kind } = request;
  const single = projects.length === 1;
  const terminalCount = projects.reduce((sum, p) => sum + p.terminalCount, 0);
  const activeAgentCount = projects.reduce((sum, p) => sum + p.activeAgentCount, 0);
  const waitingAgentCount = projects.reduce((sum, p) => sum + p.waitingAgentCount, 0);
  const showMemory = kind === "idle";
  const readings = projects.flatMap((p) =>
    p.terminalMemoryMB === undefined ? [] : [p.terminalMemoryMB]
  );
  const totalMB = readings.reduce((sum, mb) => sum + mb, 0);
  const unmeasured = projects.length - readings.length;
  const waitForIdle = request.offerWhenIdle === true && when === "idle";

  return (
    <ConfirmDialog
      isOpen={true}
      onClose={() => onChoose(null)}
      title={
        single
          ? `Sleep '${projects[0]!.name}'?`
          : `Sleep ${pluralize(
              projects.length,
              kind === "idle" ? "idle project" : kind === "all" ? "open project" : "project"
            )}?`
      }
      confirmLabel={waitForIdle ? "Sleep when idle" : single ? "Sleep project" : "Sleep projects"}
      cancelLabel="Cancel"
      onConfirm={() => onChoose(waitForIdle ? { when: "idle", pauseNote } : { when: "now" })}
      variant="default"
    >
      <div className="space-y-3">
        <ul data-sleep-projects="" className="space-y-2">
          {projects.map((project) => (
            <ProjectRow key={project.id} project={project} showMemory={showMemory} />
          ))}
        </ul>
        {/* An idle batch can hold only projects with nothing running, and the
            warning names what will be stopped. */}
        {(terminalCount > 0 || activeAgentCount > 0 || waitingAgentCount > 0) && (
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
        {request.offerWhenIdle && (
          <WhenToSleepChoice
            when={when}
            pauseNote={pauseNote}
            onWhen={setWhen}
            onPauseNote={setPauseNote}
          />
        )}
        {showMemory && readings.length > 0 && (
          <div data-sleep-memory-total="" className="text-xs text-text-secondary">
            {unmeasured === 0
              ? `Up to ${formatEstimatedMemory(totalMB)} of terminal memory, estimated.`
              : `About ${formatEstimatedMemory(totalMB)} across the ${pluralize(readings.length, "project")} measured, estimated.`}{" "}
            Processes share pages, so the memory actually freed is lower.
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

function ProjectSleepConfirmDialogInner() {
  const pending = useProjectSleepConfirmStore((s) => s.pendingConfirm);
  const requestSeq = useProjectSleepConfirmStore((s) => s.requestSeq);
  const resolveChoice = useProjectSleepConfirmStore((s) => s.resolveChoice);
  if (!pending) return null;

  const { projects, kind } = pending.request;
  if (kind === "restart") {
    return (
      <RestartConfirm
        project={projects[0]!}
        onConfirm={() => resolveChoice({ when: "now" })}
        onCancel={() => resolveChoice(null)}
      />
    );
  }
  // Keyed on the request, so a superseding one starts from "now" again.
  return <SleepConfirm key={requestSeq} request={pending.request} onChoose={resolveChoice} />;
}

/**
 * Host for the sleep confirmation `project.sleep` and `project.sleepIdle` await,
 * and for the wait a "when idle" choice starts. Mounted app-wide: the palette
 * closes on pick and the memory notice clears on recovery, so a dialog owned by
 * either would unmount under the request.
 */
export function ProjectSleepConfirmDialog() {
  const requestSeq = useProjectSleepConfirmStore((s) => s.requestSeq);
  return (
    <>
      <ErrorBoundary
        variant="component"
        componentName="ProjectSleepConfirmDialog"
        resetKeys={[requestSeq]}
        onError={() => useProjectSleepConfirmStore.getState().resolveConfirmation(false)}
      >
        <ProjectSleepConfirmDialogInner />
      </ErrorBoundary>
      <ProjectSleepWaitDialog />
    </>
  );
}
