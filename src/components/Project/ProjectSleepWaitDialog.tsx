import { ErrorBoundary } from "@/components/ErrorBoundary";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { pluralize } from "@/lib/pluralize";
import {
  cancelSleepWait,
  keepWaiting,
  sleepWaitingNow,
  SLEEP_WAIT_TIMEOUT_MS,
} from "@/services/projectSleepWait";
import {
  useProjectSleepWaitStore,
  type SleepWaitAgent,
  type SleepWaitObservation,
  type SleepWaitProject,
  type SleepWaitProjectStatus,
} from "@/store/projectSleepWaitStore";

/** What was seen, never what it means: "Waiting for input" is not "paused safely". */
export const OBSERVATION_LABEL: Record<SleepWaitObservation, string> = {
  working: "Working",
  directing: "Receiving input",
  approval: "Waiting for approval",
  question: "Asked a question",
  error: "Blocked by an error",
  "waiting-input": "Waiting for input",
  idle: "Idle",
  completed: "Completed",
  starting: "No state reading yet",
};

const STATUS_LABEL: Record<SleepWaitProjectStatus, string> = {
  waiting: "Waiting on its agents",
  ready: "Ready to sleep",
  unavailable: "Couldn't read its terminals",
  "left-open": "Left open",
  gone: "Already asleep or closed",
  sleeping: "Sleeping…",
  slept: "Asleep",
  failed: "Couldn't sleep",
};

function AgentRow({ agent }: { agent: SleepWaitAgent }) {
  return (
    <li
      className="flex items-baseline justify-between gap-3 text-xs"
      data-sleep-wait-agent={agent.terminalId}
    >
      <span className="min-w-0 truncate text-text-primary">{agent.title}</span>
      <span className="shrink-0 text-text-secondary" data-observation={agent.observation}>
        {OBSERVATION_LABEL[agent.observation]}
        {agent.note === "sent" && " · asked to pause"}
        {agent.note === "refused" && " · pause note refused"}
      </span>
    </li>
  );
}

function ProjectBlock({ project }: { project: SleepWaitProject }) {
  return (
    <li data-sleep-wait-project={project.id} data-status={project.status}>
      <div className="flex items-baseline justify-between gap-3">
        <div className="min-w-0 truncate text-sm font-medium text-text-primary">{project.name}</div>
        <div className="shrink-0 text-xs text-text-secondary">{STATUS_LABEL[project.status]}</div>
      </div>
      {project.agents.length > 0 ? (
        <ul className="mt-1 space-y-0.5 pl-3">
          {project.agents.map((agent) => (
            <AgentRow key={agent.terminalId} agent={agent} />
          ))}
        </ul>
      ) : (
        <div className="mt-1 pl-3 text-xs text-text-secondary">No agents observed</div>
      )}
    </li>
  );
}

function ProjectSleepWaitDialogInner() {
  const run = useProjectSleepWaitStore((s) => s.run);
  if (!run) return null;

  const single = run.projects.length === 1;
  const subject = single ? `'${run.projects[0]!.name}'` : pluralize(run.projects.length, "project");
  const sleeping = run.phase === "sleeping";
  const timedOut = run.phase === "timed-out";
  const title = sleeping
    ? `Sleeping ${subject}`
    : timedOut
      ? `Still waiting to sleep ${subject}`
      : `Waiting to sleep ${subject}`;
  const minutes = Math.round(SLEEP_WAIT_TIMEOUT_MS / 60_000);

  return (
    <ConfirmDialog
      isOpen={true}
      onClose={cancelSleepWait}
      title={title}
      confirmLabel="Sleep now"
      cancelLabel="Cancel"
      onConfirm={() => sleepWaitingNow()}
      isBusy={sleeping}
      variant="default"
      hasPreview
      leadingAction={
        timedOut ? { label: "Keep waiting", onClick: keepWaiting, disabled: sleeping } : undefined
      }
      hint={
        timedOut
          ? `The wait has reached ${minutes} minutes. Nothing sleeps until you choose.`
          : undefined
      }
    >
      <div className="space-y-3">
        <div className="text-xs text-text-secondary">
          {single ? "It sleeps" : "They sleep"} once every agent has been observed idle or waiting
          for input for a few seconds. An agent waiting on an approval or a question holds{" "}
          {single ? "it" : "them"} open. Sleep now stops whatever is still running; Cancel sleeps
          nothing.
        </div>
        {/* The footer's choices change with the phase; say so to someone not looking at them. */}
        <div className="sr-only" aria-live="polite" data-sleep-wait-announce="">
          {timedOut
            ? "Still waiting. Nothing sleeps until you choose Sleep now, Keep waiting or Cancel."
            : sleeping
              ? "Sleeping projects"
              : ""}
        </div>
        <ul data-sleep-wait-projects="" className="max-h-80 space-y-3 overflow-y-auto">
          {run.projects.map((project) => (
            <ProjectBlock key={project.id} project={project} />
          ))}
        </ul>
      </div>
    </ConfirmDialog>
  );
}

/** The live list a Sleep that waits for agents shows until it sleeps or is cancelled (#17882). */
export function ProjectSleepWaitDialog() {
  const runId = useProjectSleepWaitStore((s) => s.run?.id ?? 0);
  return (
    <ErrorBoundary
      variant="component"
      componentName="ProjectSleepWaitDialog"
      resetKeys={[runId]}
      // A wait no one can see must not go on to sleep anything.
      onError={cancelSleepWait}
    >
      <ProjectSleepWaitDialogInner />
    </ErrorBoundary>
  );
}
