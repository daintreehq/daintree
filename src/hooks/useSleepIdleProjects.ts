import { useCallback, useMemo, useRef, useState } from "react";
import type { Project } from "@shared/types/project";
import type { ProjectStatusMap } from "@shared/types/ipc/project";
import { notify } from "@/lib/notify";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { useProjectStatsStore } from "@/store/projectStatsStore";
import { useProjectStore } from "@/store/projectStore";

export interface IdleProject {
  id: string;
  name: string;
  path: string;
  waitingAgentCount: number;
  processCount: number;
}

/**
 * Projects the memory notice may offer to sleep (#13223): open in the
 * background, with stats on hand that report no agent mid-task. Waiting agents
 * count as idle — they hold their memory while doing nothing, and sleep keeps
 * their sessions for the reopen. The project on screen here is never a
 * candidate, nor is the one the status singleton marks active, which may be on
 * screen in another window. A project with no stats entry is unknown, not
 * empty, so it is left out.
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
      processCount: entry.processCount,
    });
  }
  return idle;
}

export interface SleepIdleProjects {
  /** Live candidates; the offer is shown only while this is non-empty. */
  idleProjects: IdleProject[];
  /** The set frozen when the confirmation opened, or null while it is closed. */
  preview: IdleProject[] | null;
  isSleeping: boolean;
  openPreview: () => void;
  closePreview: () => void;
  confirm: () => Promise<void>;
}

/**
 * Sleeps every confirmed project in turn, through the store so each one gets
 * the same ordered teardown as the project switcher's "Sleep project". A
 * failure doesn't stop the rest; the failures are reported together, once.
 */
async function sleepProjects(projects: readonly IdleProject[]): Promise<void> {
  const failed: IdleProject[] = [];
  let lastError: unknown = null;
  for (const project of projects) {
    try {
      await useProjectStore.getState().sleepProject(project.id);
    } catch (error) {
      failed.push(project);
      lastError = error;
    }
  }
  if (failed.length === 0) return;
  const names = failed.map((project) => project.name).join(", ");
  notify({
    type: "error",
    title: failed.length === 1 ? "Couldn't sleep project" : "Couldn't sleep projects",
    message: `${names}: ${formatErrorMessage(lastError, "Couldn't put the project to sleep")}`,
    actions: [{ label: "Try again", variant: "primary", onClick: () => sleepProjects(failed) }],
    context: { eventKind: "uiFeedback" },
  });
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
  const sleepingRef = useRef(false);

  const openPreview = useCallback(() => {
    if (idleProjects.length > 0) setPreview(idleProjects);
  }, [idleProjects]);

  const closePreview = useCallback(() => {
    if (!sleepingRef.current) setPreview(null);
  }, []);

  const confirm = useCallback(async () => {
    if (!preview || sleepingRef.current) return;
    // Only ever narrows what the user saw: a project that started work, closed,
    // or came on screen since the dialog opened is skipped, never swapped in.
    const { projects: liveProjects, currentProject } = useProjectStore.getState();
    const stillIdle = new Set(
      selectIdleProjects(
        liveProjects,
        useProjectStatsStore.getState().stats,
        currentProject?.id ?? null
      ).map((project) => project.id)
    );
    const targets = preview.filter((project) => stillIdle.has(project.id));
    sleepingRef.current = true;
    setIsSleeping(true);
    try {
      await sleepProjects(targets);
    } finally {
      sleepingRef.current = false;
      setIsSleeping(false);
      setPreview(null);
    }
  }, [preview]);

  return { idleProjects, preview, isSleeping, openPreview, closePreview, confirm };
}
