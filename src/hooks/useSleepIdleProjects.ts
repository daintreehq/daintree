import { useCallback, useMemo, useState } from "react";
import type { Project } from "@shared/types/project";
import type { ProjectStatusMap } from "@shared/types/ipc/project";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { projectPresenceClient } from "@/clients/projectPresenceClient";
import { terminalClient } from "@/clients/terminalClient";
import { notify } from "@/lib/notify";
import { pluralize } from "@/lib/pluralize";
import { useProjectStatsStore } from "@/store/projectStatsStore";
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
 * Projects the memory notice may offer to sleep (#13223), as far as the pushed
 * stats can tell: open in the background, with no agent mid-task. Waiting
 * agents count as idle — they hold their memory while doing nothing, and sleep
 * keeps their sessions for the reopen. The project on screen here is never a
 * candidate, nor is the one the status singleton marks active. A project with
 * no stats entry is unknown, not empty, so it is left out.
 *
 * Stats can't see everything — a hidden assistant reports no state, and another
 * window's project still reads `background` — so {@link confirmStillIdle} checks
 * each one against live state before it is offered or slept.
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
    if (!entry || entry.activeAgentCount > 0) continue;
    if (entry.assistantState === "working" || entry.assistantState === "directing") continue;
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

function currentCandidates(): IdleProject[] {
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
    if (t.agentState === "working" || t.agentState === "directing") live.busy = true;
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

function sleepProjects(ids: readonly string[]): Promise<void> {
  const run = batchQueue.then(() => runBatch(ids));
  batchQueue = run;
  return run;
}

/**
 * Sleeps each project in turn through the store, so each gets the project
 * switcher's ordered teardown. Each is re-checked right before its own sleep —
 * an earlier one in the batch can take a while, and nothing in main refuses a
 * project that started work since the preview. A failure doesn't stop the
 * rest; the failures are reported together, once. Never rejects.
 */
async function runBatch(ids: readonly string[]): Promise<void> {
  const failed: Array<{ project: IdleProject; error: unknown }> = [];
  for (const id of ids) {
    const [project] = await confirmStillIdle([id]);
    if (!project) continue;
    try {
      await useProjectStore.getState().sleepProject(project.id);
    } catch (error) {
      failed.push({ project, error });
    }
  }
  if (failed.length === 0) return;

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
}

export interface SleepIdleProjects {
  /** Candidates by the stats; the offer is shown only while this is non-empty. */
  idleProjects: IdleProject[];
  /** The checked set frozen when the confirmation opened, or null while closed. */
  preview: IdleProject[] | null;
  isSleeping: boolean;
  openPreview: () => Promise<void>;
  closePreview: () => void;
  confirm: () => Promise<void>;
}

export function useSleepIdleProjects(): SleepIdleProjects {
  const projects = useProjectStore((s) => s.projects);
  const currentProjectId = useProjectStore((s) => s.currentProject?.id ?? null);
  const stats = useProjectStatsStore((s) => s.stats);
  const idleProjects = useMemo(
    () => selectIdleProjects(projects, stats, currentProjectId),
    [projects, stats, currentProjectId]
  );

  const [preview, setPreview] = useState<IdleProject[] | null>(null);
  const [isSleeping, setIsSleeping] = useState(false);

  const openPreview = useCallback(async () => {
    const checked = await confirmStillIdle(idleProjects.map((project) => project.id));
    if (checked.length > 0) {
      setPreview(checked);
      return;
    }
    notify({
      type: "info",
      priority: "high",
      title: "No idle projects",
      message: "Every background project has an agent working or is open in a window.",
      context: { eventKind: "uiFeedback" },
    });
  }, [idleProjects]);

  const closePreview = useCallback(() => {
    if (!isSleeping) setPreview(null);
  }, [isSleeping]);

  const confirm = useCallback(async () => {
    if (!preview || isSleeping) return;
    setIsSleeping(true);
    // Only ever narrows what the user saw: a project that changed since the
    // preview is skipped, never swapped in.
    await sleepProjects(preview.map((project) => project.id));
    setIsSleeping(false);
    setPreview(null);
  }, [preview, isSleeping]);

  return { idleProjects, preview, isSleeping, openPreview, closePreview, confirm };
}
