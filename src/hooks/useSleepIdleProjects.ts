import { useCallback, useMemo } from "react";
import type { AgentState, WaitingReason } from "@shared/types/agent";
import type { Project } from "@shared/types/project";
import type { ProjectStatusMap } from "@shared/types/ipc/project";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { actionableWaitingReason } from "@shared/utils/waitingReasonDisplay";
import { projectPresenceClient } from "@/clients/projectPresenceClient";
import { projectClient } from "@/clients/projectClient";
import { terminalClient } from "@/clients/terminalClient";
import { notify } from "@/lib/notify";
import { pluralize } from "@/lib/pluralize";
import { useProjectStatsStore } from "@/store/projectStatsStore";
import { useProjectSleepConfirmStore } from "@/store/projectSleepConfirmStore";
import { useProjectStore } from "@/store/projectStore";

export interface IdleProject {
  id: string;
  name: string;
  path: string;
  waitingAgentCount: number;
  /** Live terminal PTYs, agents included — not the process tree under them. */
  terminalCount: number;
}

/**
 * An agent mid-task, or one waiting on an approval, a question or an error
 * (#13842). Sleeping it would drop a decision out of the attention views
 * unseen, and the quit keystrokes could answer the prompt. A wait at the
 * prompt, or with no more specific reason, holds memory while doing nothing.
 */
function keepsProjectAwake(state: AgentState | undefined, reason: WaitingReason | undefined) {
  if (state === "working" || state === "directing") return true;
  return state === "waiting" && actionableWaitingReason(reason) !== null;
}

/**
 * Projects the memory notice may offer to sleep (#13223), as far as the pushed
 * stats can tell: open in the background, with no agent mid-task or blocked.
 * Agents waiting at their prompt count as idle — they hold their memory while
 * doing nothing, and sleep keeps their sessions for the reopen. The project on
 * screen here is never a candidate, nor is the one the status singleton marks
 * active. A project with no stats entry is unknown, not empty, so it is left out.
 *
 * Stats can't see everything — a hidden assistant reports no state, an approval
 * or a question is only a waiting count, and another window's project still
 * reads `background` — so {@link confirmStillIdle} checks each one against live
 * state before it is offered or slept.
 */
export function selectIdleProjects(
  projects: readonly Project[],
  stats: ProjectStatusMap,
  currentProjectId: string | null
): IdleProject[] {
  const idle: IdleProject[] = [];
  for (const project of projects) {
    if (project.status !== "background" || project.id === currentProjectId) continue;
    const entry = stats[project.id];
    if (!entry || entry.activeAgentCount > 0 || entry.blockedAgentCount > 0) continue;
    if (keepsProjectAwake(entry.assistantState, entry.assistantWaitingReason)) continue;
    idle.push({
      id: project.id,
      name: project.name,
      path: project.path,
      waitingAgentCount: entry.waitingAgentCount,
      terminalCount: entry.processCount,
    });
  }
  return idle;
}

export function currentCandidates(): IdleProject[] {
  const { projects, currentProject } = useProjectStore.getState();
  return selectIdleProjects(
    projects,
    useProjectStatsStore.getState().stats,
    currentProject?.id ?? null
  );
}

/**
 * The subset of `ids` that is still idle by every live reading: the stats, any
 * window showing it, and every terminal it owns — assistants included, hidden
 * or not. Local eligibility is read again after the awaits, so a project that
 * came on screen or started work meanwhile drops out. A reading that fails, or
 * that finds no terminals for a project the stats say has some (a host shard
 * that didn't answer reads as empty), rules the project out.
 */
async function confirmStillIdle(ids: readonly string[]): Promise<IdleProject[]> {
  const wanted = new Set(ids);
  if (!currentCandidates().some((project) => wanted.has(project.id))) return [];
  let shownSomewhere: Set<string>;
  let terminals: Awaited<ReturnType<typeof terminalClient.getAll>>;
  try {
    const [presence, all] = await Promise.all([
      projectPresenceClient.getSnapshot(),
      terminalClient.getAll(),
    ]);
    shownSomewhere = new Set(
      [...presence.thisWindow, ...presence.otherWindows]
        .filter((entry) => entry.state !== "cached")
        .map((entry) => entry.projectId)
    );
    terminals = all;
  } catch {
    return [];
  }
  const liveByProject = new Map<string, { count: number; busy: boolean }>();
  for (const t of terminals) {
    // An exited agent can keep a stale `working` on its record.
    if (!t.projectId || t.isTrashed || t.hasPty === false) continue;
    const live = liveByProject.get(t.projectId) ?? { count: 0, busy: false };
    live.count++;
    if (keepsProjectAwake(t.agentState, t.waitingReason)) live.busy = true;
    liveByProject.set(t.projectId, live);
  }
  return currentCandidates().filter((project) => {
    if (!wanted.has(project.id) || shownSomewhere.has(project.id)) return false;
    const live = liveByProject.get(project.id);
    if (live?.busy) return false;
    return project.terminalCount === 0 || (live?.count ?? 0) > 0;
  });
}

/**
 * Batches run one after another, app-wide for this view: a retry landing while
 * a confirmed batch is still going waits its turn rather than overlapping it or
 * being dropped. Module scope rather than component state, because the notice
 * that owns the button clears on recovery and a batch it started must outlive
 * it.
 */
let batchQueue: Promise<void> = Promise.resolve();

export function sleepProjects(ids: readonly string[]): Promise<number> {
  const run = batchQueue.then(() => runBatch(ids));
  batchQueue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/**
 * Sleeps each project in turn through the store, so each gets the project
 * switcher's ordered teardown. Each is re-checked right before its own sleep —
 * an earlier one in the batch can take a while, and nothing in main refuses a
 * project that started work since the preview. A failure doesn't stop the
 * rest; the failures are reported together, once. Resolves with how many actually
 * slept, and never rejects.
 */
async function runBatch(ids: readonly string[]): Promise<number> {
  const failed: Array<{ project: IdleProject; error: unknown }> = [];
  let slept = 0;
  for (const id of ids) {
    const [project] = await confirmStillIdle([id]);
    if (!project) continue;
    try {
      await useProjectStore.getState().sleepProject(project.id);
      slept++;
    } catch (error) {
      failed.push({ project, error });
    }
  }
  if (failed.length === 0) return slept;

  const message =
    failed.length === 1
      ? `'${failed[0]!.project.name}' is still open. ${formatErrorMessage(failed[0]!.error, "The project couldn't be put to sleep")}`
      : `${pluralize(failed.length, "project")} are still open: ${failed
          .map(({ project }) => `'${project.name}'`)
          .join(", ")}. Try again, or sleep each one from the project switcher.`;
  notify({
    type: "error",
    // A toast, not the inbox `uiFeedback` defaults to: the retry lives on the
    // toast, and the inbox keeps only actions it can dispatch by id.
    priority: "high",
    title: failed.length === 1 ? "Couldn't sleep project" : "Couldn't sleep projects",
    message,
    actions: [
      {
        label: "Try again",
        variant: "primary",
        onClick: () => sleepProjects(failed.map(({ project }) => project.id)),
      },
    ],
    context: { eventKind: "uiFeedback" },
  });
  return slept;
}

/**
 * The terminal memory reading per project, for the preview. One bulk call for
 * the whole batch; a project without a reading, or a call that fails, is left
 * out rather than counted as zero.
 */
async function readTerminalMemory(ids: readonly string[]): Promise<Map<string, number>> {
  const readings = new Map<string, number>();
  try {
    const bulk = await projectClient.getBulkStats([...ids]);
    for (const id of ids) {
      const mb = bulk[id]?.terminalMemoryMB;
      if (typeof mb === "number") readings.set(id, mb);
    }
  } catch {
    // The estimate is garnish; the preview shows it as unavailable.
  }
  return readings;
}

/**
 * Previews, confirms and sleeps every idle background project, however it was
 * reached: the memory notice, the palette, a keybinding or MCP. The checked set
 * is frozen when the preview opens and the batch only ever narrows it. Resolves
 * with how many projects actually slept: 0 when there was nothing to offer, the
 * user cancelled, or every one dropped out or failed. `alreadyApproved` skips
 * the dialog for a dispatch the MCP bridge's own confirm has cleared.
 */
export async function sleepIdleProjectsWithConfirm(
  options: { alreadyApproved?: boolean } = {}
): Promise<number> {
  const candidates = currentCandidates();
  const checked = await confirmStillIdle(candidates.map((project) => project.id));
  if (checked.length === 0) {
    notify({
      type: "info",
      priority: "high",
      title: "No idle projects",
      message:
        "Every background project has an agent working or waiting on you, or is open in a window.",
      context: { eventKind: "uiFeedback" },
    });
    return 0;
  }
  if (options.alreadyApproved) return sleepProjects(checked.map((project) => project.id));
  const memory = await readTerminalMemory(checked.map((project) => project.id));
  const ok = await useProjectSleepConfirmStore.getState().requestConfirmation({
    kind: "idle",
    projects: checked.map((project) => ({
      id: project.id,
      name: project.name,
      path: project.path,
      terminalCount: project.terminalCount,
      waitingAgentCount: project.waitingAgentCount,
      activeAgentCount: 0,
      isActive: false,
      terminalMemoryMB: memory.get(project.id),
    })),
  });
  if (!ok) return 0;
  return sleepProjects(checked.map((project) => project.id));
}

export interface SleepIdleProjects {
  /** Candidates by the stats; the offer is shown only while this is non-empty. */
  idleProjects: IdleProject[];
  openPreview: () => Promise<void>;
}

export function useSleepIdleProjects(): SleepIdleProjects {
  const projects = useProjectStore((s) => s.projects);
  const currentProjectId = useProjectStore((s) => s.currentProject?.id ?? null);
  const stats = useProjectStatsStore((s) => s.stats);
  const idleProjects = useMemo(
    () => selectIdleProjects(projects, stats, currentProjectId),
    [projects, stats, currentProjectId]
  );

  const openPreview = useCallback(async () => {
    await sleepIdleProjectsWithConfirm();
  }, []);

  return { idleProjects, openPreview };
}
