import type { SleepRequestWorking } from "@shared/types/ipc/project";
import type { BackendTerminalInfo } from "@shared/types/ipc/terminal";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { actionableWaitingReason } from "@shared/utils/waitingReasonDisplay";
import { projectPresenceClient } from "@/clients/projectPresenceClient";
import { terminalClient } from "@/clients/terminalClient";
import { notify } from "@/lib/notify";
import { pluralize } from "@/lib/pluralize";
import { useProjectStatsStore } from "@/store/projectStatsStore";
import { useProjectStore } from "@/store/projectStore";
import {
  useProjectSleepWaitStore,
  type SleepWaitAgent,
  type SleepWaitObservation,
  type SleepWaitProject,
  type SleepWaitProjectStatus,
  type SleepWaitRun,
} from "@/store/projectSleepWaitStore";

/**
 * Sleep that waits for agents to settle first (#17882). A run lives in the view
 * that started it, like the idle batch, so each project still sleeps through
 * `useProjectStore.sleepProject` and its flush-then-teardown ordering. No
 * project sleeps until every remaining one qualifies, so Cancel sleeps nothing.
 * If the view stops running (a freeze, an eviction), the run stops with it and
 * nothing sleeps.
 */

export const SLEEP_WAIT_POLL_MS = 1_500;
/**
 * How long a project must read as settled, unchanged, before it counts. Agents
 * read idle for a moment between tool calls; any change restarts the clock.
 */
export const SLEEP_WAIT_DWELL_MS = 5_000;
/** When the wait stops sleeping on its own and asks instead. */
export const SLEEP_WAIT_TIMEOUT_MS = 30 * 60_000;

export const SLEEP_PAUSE_NOTE =
  "Please finish your current step, then stop and wait for my next instruction.";

const BLOCKING: ReadonlySet<SleepWaitObservation> = new Set([
  "working",
  "directing",
  "approval",
  "question",
  "error",
  "starting",
]);

export function observationBlocksSleep(observation: SleepWaitObservation): boolean {
  return BLOCKING.has(observation);
}

function isLiveTerminal(t: BackendTerminalInfo): boolean {
  return !t.isTrashed && t.hasPty !== false;
}

/** What one terminal shows, or null when it isn't a live agent. */
export function observeAgent(t: BackendTerminalInfo): SleepWaitObservation | null {
  if (!isLiveTerminal(t)) return null;
  if ((t.detectedAgentId ?? t.launchAgentId) === undefined) return null;
  switch (t.agentState) {
    case "working":
    case "directing":
    case "completed":
      return t.agentState;
    case "waiting":
      return actionableWaitingReason(t.waitingReason) ?? "waiting-input";
    case "exited":
      return null;
    default:
      // A launch seeds `idle` before the output has said anything, and a
      // healthy monitor reports within moments; a seed that never moves is a
      // reading that never came, not a settled agent.
      return t.lastStateChange === undefined || t.lastStateChange === t.spawnedAt
        ? "starting"
        : "idle";
  }
}

interface Reading {
  terminals: BackendTerminalInfo[];
  /** Projects a window is showing or about to show. */
  shown: Set<string>;
}

async function readShown(): Promise<Set<string>> {
  const presence = await projectPresenceClient.getSnapshot();
  return new Set(
    [...presence.thisWindow, ...presence.otherWindows]
      .filter((entry) => entry.state !== "cached")
      .map((entry) => entry.projectId)
  );
}

async function readLive(): Promise<Reading> {
  const [terminals, shown] = await Promise.all([terminalClient.getAll(), readShown()]);
  return { terminals, shown };
}

interface Tracker {
  signature: string;
  settledSince: number | null;
  /** Seen off screen during this run, so being shown again is the user coming back. */
  hiddenSeen: boolean;
}

/** Per project, the agents a Sleep request found working (#17886). */
export type WorkingAtRequest = ReadonlyMap<string, readonly SleepRequestWorking[]>;

interface ActiveRun {
  id: number;
  deadline: number;
  trackers: Map<string, Tracker>;
  notes: Map<string, "sent" | "refused">;
  timer: ReturnType<typeof setTimeout> | null;
  /**
   * Read once, when the request began: by the time a project sleeps its agents
   * have settled, and the restore after must still know which ones were
   * interrupted mid-task.
   */
  workingAtRequest: Map<string, readonly SleepRequestWorking[]>;
}

let active: ActiveRun | null = null;
let nextRunId = 0;

function viewOf(run: ActiveRun): SleepWaitRun | null {
  const view = useProjectSleepWaitStore.getState().run;
  return active === run && view?.id === run.id ? view : null;
}

function publish(run: ActiveRun, patch: Partial<SleepWaitRun>): void {
  const view = viewOf(run);
  if (view) useProjectSleepWaitStore.getState().setRun({ ...view, ...patch });
}

function setProjectStatus(run: ActiveRun, id: string, status: SleepWaitProjectStatus): void {
  const view = viewOf(run);
  if (!view) return;
  publish(run, { projects: view.projects.map((p) => (p.id === id ? { ...p, status } : p)) });
}

function clearTimer(run: ActiveRun): void {
  if (run.timer !== null) clearTimeout(run.timer);
  run.timer = null;
}

export function isPendingStatus(status: SleepWaitProjectStatus): boolean {
  return status === "waiting" || status === "ready" || status === "unavailable";
}

interface Observed {
  status: SleepWaitProjectStatus;
  agents: SleepWaitAgent[];
  settled: boolean;
  signature: string;
}

function observeProject(
  run: ActiveRun,
  id: string,
  reading: Reading
): Observed | "left-open" | "gone" {
  const project = useProjectStore.getState().projects.find((p) => p.id === id);
  if (!project || project.status === "closed" || project.status === "missing") return "gone";
  const tracker = run.trackers.get(id)!;
  if (reading.shown.has(id)) {
    if (tracker.hiddenSeen) return "left-open";
  } else {
    tracker.hiddenSeen = true;
  }
  const own = reading.terminals.filter((t) => t.projectId === id && isLiveTerminal(t));
  const agents = own.flatMap((t): SleepWaitAgent[] => {
    const observation = observeAgent(t);
    if (!observation) return [];
    const note = run.notes.get(t.id);
    return [
      { terminalId: t.id, title: t.title || "Agent", observation, ...(note ? { note } : {}) },
    ];
  });
  // The pushed counts are read alongside: they come from main's own inventory
  // and carry the project's hidden assistant, which counts leave out.
  const stats = useProjectStatsStore.getState().stats[id];
  const assistantState = stats?.assistantState;
  const assistantLive = assistantState !== undefined && assistantState !== "exited";
  const assistantBusy =
    assistantState === "working" ||
    assistantState === "directing" ||
    (assistantState === "waiting" &&
      actionableWaitingReason(stats?.assistantWaitingReason) !== null);
  const signature = [
    ...own.map(
      (t) => `${t.id}:${t.agentState}:${t.waitingReason}:${t.lastStateChange}:${t.agentIncarnation}`
    ),
    `assistant:${assistantState}:${stats?.assistantWaitingReason}:${stats?.assistantStateSince}`,
  ]
    .sort()
    .join("|");
  // A host shard that didn't answer reads as no terminals, which must not pass
  // for a quiet project when the counts know of anything running there. That
  // holds a project whose only process is a dev preview, which the list never
  // shows, until the user chooses; the row says what was seen.
  const counted =
    (stats?.processCount ?? 0) +
    (stats?.activeAgentCount ?? 0) +
    (stats?.waitingAgentCount ?? 0) +
    (stats?.blockedAgentCount ?? 0) +
    (stats?.completedAgentCount ?? 0);
  if ((counted > 0 || assistantLive) && own.length === 0) {
    return { status: "unavailable", agents, settled: false, signature };
  }
  const settled =
    (stats?.activeAgentCount ?? 0) === 0 &&
    (stats?.blockedAgentCount ?? 0) === 0 &&
    !assistantBusy &&
    agents.every((a) => !observationBlocksSleep(a.observation));
  return { status: "waiting", agents, settled, signature };
}

function nextProjectState(
  run: ActiveRun,
  project: SleepWaitProject,
  reading: Reading | null,
  now: number
): SleepWaitProject {
  if (!isPendingStatus(project.status)) return project;
  const tracker = run.trackers.get(project.id)!;
  if (!reading) {
    tracker.settledSince = null;
    return { ...project, status: "unavailable" };
  }
  const observed = observeProject(run, project.id, reading);
  if (observed === "left-open" || observed === "gone") return { ...project, status: observed };
  if (!observed.settled) {
    tracker.settledSince = null;
  } else if (tracker.settledSince === null || observed.signature !== tracker.signature) {
    tracker.settledSince = now;
  }
  tracker.signature = observed.signature;
  const ready =
    observed.status === "waiting" &&
    tracker.settledSince !== null &&
    now - tracker.settledSince >= SLEEP_WAIT_DWELL_MS;
  return { ...project, agents: observed.agents, status: ready ? "ready" : observed.status };
}

async function tick(run: ActiveRun): Promise<void> {
  run.timer = null;
  let reading: Reading | null;
  try {
    reading = await readLive();
  } catch {
    reading = null;
  }
  const view = viewOf(run);
  if (!view || view.phase === "sleeping") return;
  const now = Date.now();
  const projects = view.projects.map((p) => nextProjectState(run, p, reading, now));
  const phase = view.phase === "waiting" && now >= run.deadline ? "timed-out" : view.phase;
  publish(run, { phase, projects });

  const remaining = projects.filter((p) => isPendingStatus(p.status));
  if (remaining.length === 0) {
    finish(run, false);
    return;
  }
  if (phase === "waiting" && remaining.every((p) => p.status === "ready")) {
    void commit(run, false);
    return;
  }
  run.timer = setTimeout(() => void tick(run), SLEEP_WAIT_POLL_MS);
}

/**
 * Right before a project's own turn. A forced sleep still spares a project the
 * user came back to; otherwise it must read exactly as it did when it earned
 * its dwell, so an agent that worked and settled again, a new one, or a reading
 * that recovered since all leave it open.
 */
async function turnVerdict(
  run: ActiveRun,
  id: string,
  force: boolean
): Promise<"sleep" | "left-open" | "gone"> {
  if (force) return forcedVerdict(run, id);
  let reading: Reading;
  try {
    reading = await readLive();
  } catch {
    return "left-open";
  }
  const observed = observeProject(run, id, reading);
  if (observed === "left-open" || observed === "gone") return observed;
  const unchanged =
    observed.status === "waiting" &&
    observed.settled &&
    observed.signature === run.trackers.get(id)!.signature;
  return unchanged ? "sleep" : "left-open";
}

/**
 * Sleep now asks nothing of the agents, so only presence is read: a terminal
 * listing that fails or lags must not cost the check that the user came back.
 */
async function forcedVerdict(run: ActiveRun, id: string): Promise<"sleep" | "left-open" | "gone"> {
  const project = useProjectStore.getState().projects.find((p) => p.id === id);
  if (!project || project.status === "closed" || project.status === "missing") return "gone";
  try {
    const shown = await readShown();
    if (shown.has(id) && run.trackers.get(id)!.hiddenSeen) return "left-open";
  } catch {
    // Unread presence leaves the forced sleep as the user asked for it.
  }
  return "sleep";
}

/** The project this view shows goes last: sleeping it drops the view to the picker. */
function inSleepOrder(ids: readonly string[]): string[] {
  const currentId = useProjectStore.getState().currentProject?.id;
  return [...ids].sort((a, b) => Number(a === currentId) - Number(b === currentId));
}

async function commit(run: ActiveRun, force: boolean): Promise<void> {
  const view = viewOf(run);
  if (!view || view.phase === "sleeping") return;
  clearTimer(run);
  publish(run, { phase: "sleeping" });
  const ids = inSleepOrder(view.projects.filter((p) => isPendingStatus(p.status)).map((p) => p.id));
  for (const id of ids) {
    const verdict = await turnVerdict(run, id, force);
    if (verdict !== "sleep") {
      setProjectStatus(run, id, verdict);
      continue;
    }
    setProjectStatus(run, id, "sleeping");
    try {
      await sleepWithRequest(id, run.workingAtRequest);
      setProjectStatus(run, id, "slept");
    } catch {
      setProjectStatus(run, id, "failed");
    }
  }
  finish(run, force);
}

/** `forced`: the user chose Sleep now, so a retry of what failed doesn't wait either. */
function finish(run: ActiveRun, forced: boolean): void {
  const view = viewOf(run);
  clearTimer(run);
  if (active === run) active = null;
  if (useProjectSleepWaitStore.getState().run?.id === run.id) {
    useProjectSleepWaitStore.getState().setRun(null);
  }
  if (!view) return;
  const leftOpen = view.projects.filter((p) => p.status === "left-open");
  const failed = view.projects.filter((p) => p.status === "failed");
  // A retry keeps the user's last word: after a wait it waits again, after Sleep now it doesn't.
  if (failed.length > 0) {
    const workingAtRequest = run.workingAtRequest;
    notifySleepFailed(
      failed,
      forced
        ? (ids) => sleepProjectsInOrder(ids, workingAtRequest)
        : (ids) => startSleepWait(ids, { pauseNote: false, workingAtRequest })
    );
  }
  if (leftOpen.length > 0) {
    notify({
      type: "info",
      priority: "high",
      title: leftOpen.length === 1 ? "Project left open" : "Projects left open",
      message: `${leftOpen.map((p) => `'${p.name}'`).join(", ")} ${
        leftOpen.length === 1 ? "wasn't" : "weren't"
      } put to sleep: you came back to ${
        leftOpen.length === 1 ? "it" : "them"
      }, an agent there started again, or ${
        leftOpen.length === 1 ? "its" : "their"
      } terminals couldn't be read before ${leftOpen.length === 1 ? "its" : "their"} turn.`,
      context: { eventKind: "uiFeedback" },
    });
  }
}

function notifySleepFailed(
  failed: ReadonlyArray<{ id: string; name: string }>,
  retry: (ids: string[]) => Promise<unknown>
): void {
  notify({
    type: "error",
    priority: "high",
    title: failed.length === 1 ? "Couldn't sleep project" : "Couldn't sleep projects",
    message:
      failed.length === 1
        ? `'${failed[0]!.name}' is still open.`
        : `${pluralize(failed.length, "project")} are still open: ${failed
            .map((p) => `'${p.name}'`)
            .join(", ")}.`,
    actions: [
      {
        label: "Try again",
        variant: "primary",
        onClick: async () => {
          await retry(failed.map((p) => p.id));
        },
      },
    ],
    context: { eventKind: "uiFeedback" },
  });
}

/**
 * One project's sleep, carrying the agents the request found working there.
 * Without any, Main records what it reads just before the kill.
 */
function sleepWithRequest(id: string, workingAtRequest: WorkingAtRequest | undefined) {
  const working = workingAtRequest?.get(id);
  return working && working.length > 0
    ? useProjectStore.getState().sleepProject(id, { workingAtRequest: [...working] })
    : useProjectStore.getState().sleepProject(id);
}

/**
 * Sleeps each project at once, one after another, the view's own project
 * last. A failure doesn't stop the rest; the failures are reported together.
 * Resolves with how many slept, and never rejects. `workingAtRequest` is what
 * an earlier request for these projects saw, kept when one is retried.
 */
export async function sleepProjectsInOrder(
  ids: readonly string[],
  workingAtRequest?: WorkingAtRequest
): Promise<number> {
  const failed: Array<{ id: string; name: string }> = [];
  let slept = 0;
  for (const id of inSleepOrder(ids)) {
    try {
      await sleepWithRequest(id, workingAtRequest);
      slept++;
    } catch (error) {
      const name = useProjectStore.getState().projects.find((p) => p.id === id)?.name ?? id;
      console.warn("[projectSleepWait] sleep failed", formatErrorMessage(error, "unknown error"));
      failed.push({ id, name });
    }
  }
  if (failed.length > 0) {
    notifySleepFailed(failed, (retry) => sleepProjectsInOrder(retry, workingAtRequest));
  }
  return slept;
}

/**
 * The agents in these projects the request finds working, added to any an
 * earlier request for them found.
 */
function recordWorkingAtRequest(
  run: ActiveRun,
  terminals: readonly BackendTerminalInfo[],
  ids: ReadonlySet<string>
): void {
  for (const t of terminals) {
    if (t.projectId === undefined || !ids.has(t.projectId)) continue;
    if (observeAgent(t) !== "working") continue;
    const recorded = run.workingAtRequest.get(t.projectId) ?? [];
    if (recorded.some((entry) => entry.terminalId === t.id)) continue;
    run.workingAtRequest.set(t.projectId, [
      ...recorded,
      {
        terminalId: t.id,
        ...(t.lastStateChange !== undefined && { at: t.lastStateChange }),
        ...(t.agentIncarnation !== undefined && { agentIncarnation: t.agentIncarnation }),
      },
    ]);
  }
}

/**
 * Sent once, only when the user ticked it for this run, only to agents read as
 * working when it began. Refused while an agent is on a choice dialog.
 */
async function sendPauseNotes(
  run: ActiveRun,
  terminals: readonly BackendTerminalInfo[],
  ids: ReadonlySet<string>
): Promise<void> {
  const recipients = terminals.filter(
    (t) =>
      t.projectId !== undefined &&
      ids.has(t.projectId) &&
      t.detectedAgentId !== undefined &&
      observeAgent(t) === "working"
  );
  // Nothing goes out once the run has ended or started sleeping.
  const live = () => viewOf(run)?.phase === "waiting";
  if (recipients.length === 0 || !live()) return;
  let submitNoteToAgent: (terminalId: string, text: string) => Promise<void>;
  try {
    // Loaded on use: the fleet's send path is heavy, and most sleeps send nothing.
    ({ submitNoteToAgent } = await import("@/components/Fleet/fleetExecution"));
  } catch {
    for (const t of recipients) run.notes.set(t.id, "refused");
    return;
  }
  if (!live()) return;
  await Promise.all(
    recipients.map(async (t) => {
      try {
        await submitNoteToAgent(t.id, SLEEP_PAUSE_NOTE);
        run.notes.set(t.id, "sent");
      } catch {
        run.notes.set(t.id, "refused");
      }
    })
  );
}

/**
 * Starts waiting on these projects. A wait already running here is replaced,
 * unless it has started sleeping. Resolves once the first reading is in.
 * `workingAtRequest` is what an earlier request for them saw, kept when one is
 * retried.
 */
export async function startSleepWait(
  ids: readonly string[],
  options: { pauseNote: boolean; workingAtRequest?: WorkingAtRequest }
): Promise<void> {
  if (useProjectSleepWaitStore.getState().run?.phase === "sleeping") {
    throw new Error("Projects are already being put to sleep");
  }
  cancelSleepWait();
  const { projects } = useProjectStore.getState();
  const targets = ids.flatMap((id): SleepWaitProject[] => {
    const project = projects.find((p) => p.id === id);
    return project ? [{ id, name: project.name, status: "waiting", agents: [] }] : [];
  });
  if (targets.length === 0) return;
  const run: ActiveRun = {
    id: ++nextRunId,
    deadline: Date.now() + SLEEP_WAIT_TIMEOUT_MS,
    trackers: new Map(
      targets.map((t) => [t.id, { signature: "", settledSince: null, hiddenSeen: false }])
    ),
    notes: new Map(),
    timer: null,
    workingAtRequest: new Map(options.workingAtRequest ?? []),
  };
  active = run;
  useProjectSleepWaitStore.getState().setRun({
    id: run.id,
    phase: "waiting",
    projects: targets,
    pauseNote: options.pauseNote,
  });
  const targetIds = new Set(targets.map((t) => t.id));
  let terminals: BackendTerminalInfo[] | null = null;
  try {
    terminals = await terminalClient.getAll();
  } catch {
    // Unread: each agent's stop is recorded from Main's own pre-kill reading.
  }
  if (terminals) {
    recordWorkingAtRequest(run, terminals, targetIds);
    if (options.pauseNote) await sendPauseNotes(run, terminals, targetIds);
  }
  if (active !== run) return;
  await tick(run);
}

/** Ends the wait with nothing slept. Too late once sleeping has begun. */
export function cancelSleepWait(): void {
  const run = active;
  if (!run) return;
  const view = viewOf(run);
  if (view?.phase === "sleeping") return;
  clearTimer(run);
  active = null;
  if (view) useProjectSleepWaitStore.getState().setRun(null);
}

/** Sleeps every project still waiting, as an immediate Sleep would, except ones the user came back to. */
export function sleepWaitingNow(): Promise<void> {
  return active ? commit(active, true) : Promise.resolve();
}

/** After the timeout: wait another full period. Nothing is sent again. */
export function keepWaiting(): void {
  const run = active;
  if (!run || viewOf(run)?.phase !== "timed-out") return;
  run.deadline = Date.now() + SLEEP_WAIT_TIMEOUT_MS;
  publish(run, { phase: "waiting" });
}
