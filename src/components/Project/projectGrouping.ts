import type { Project, ProjectStats } from "@shared/types";
import { isCanopyEnvEnabled } from "@/utils/env";

export interface GroupedProjects {
  pinned: Project[];
  active: Project[];
  background: Project[];
  recent: Project[];
}

export function groupProjects(
  projects: Project[],
  currentProjectId: string | null,
  projectStats: Map<string, ProjectStats>
): GroupedProjects {
  const isVerbose = isCanopyEnvEnabled("CANOPY_VERBOSE");

  const groups: GroupedProjects = {
    pinned: [],
    active: [],
    background: [],
    recent: [],
  };

  // Debug logging (gated for performance)
  if (isVerbose) {
    console.log("[ProjectSwitcher] groupProjects called:", {
      projectCount: projects.length,
      currentProjectId: currentProjectId?.slice(0, 8),
      statsCount: projectStats.size,
      projects: projects.map((p) => ({
        name: p.name,
        status: p.status,
        id: p.id.slice(0, 8),
        pinned: p.pinned,
      })),
    });
  }

  for (const project of projects) {
    // Active project is the currentProjectId. As a fallback (e.g. initial load), treat a project
    // marked "active" as active only when currentProjectId is unknown to avoid hiding actions
    // for background projects due to stale status.
    const isActive =
      project.id === currentProjectId || (currentProjectId == null && project.status === "active");

    if (isActive) {
      groups.active.push(project);
    } else if (project.pinned) {
      // Pinned non-active projects go to the pinned section
      groups.pinned.push(project);
    } else {
      const stats = projectStats.get(project.id);
      const hasProcesses = stats && stats.processCount > 0;
      const isBackground = project.status === "background";

      // Debug: log decision for each non-active project
      if (isVerbose) {
        console.log(`[ProjectSwitcher] Grouping "${project.name}":`, {
          status: project.status,
          isBackground,
          hasProcesses,
          processCount: stats?.processCount ?? "no stats",
        });
      }

      // Projects with running processes or explicitly backgrounded
      if (hasProcesses || isBackground) {
        groups.background.push(project);
      } else {
        groups.recent.push(project);
      }
    }
  }

  // Sort pinned projects by lastOpened (most recent first)
  groups.pinned.sort((a, b) => b.lastOpened - a.lastOpened);

  // Sort background projects by process count (most active first)
  groups.background.sort((a, b) => {
    const statsA = projectStats.get(a.id);
    const statsB = projectStats.get(b.id);
    return (statsB?.processCount || 0) - (statsA?.processCount || 0);
  });

  // Sort recent projects by lastOpened (most recent first)
  groups.recent.sort((a, b) => b.lastOpened - a.lastOpened);

  if (isVerbose) {
    console.log("[ProjectSwitcher] Grouping result:", {
      pinned: groups.pinned.map((p) => p.name),
      active: groups.active.map((p) => p.name),
      background: groups.background.map((p) => p.name),
      recent: groups.recent.map((p) => p.name),
    });
  }

  return groups;
}
