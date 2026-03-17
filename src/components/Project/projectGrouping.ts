import type { Project, ProjectStats } from "@shared/types";
import { isCanopyEnvEnabled } from "@/utils/env";
import type { ProjectGroup } from "@/store/projectGroupsStore";
import type { SearchableProject } from "@/hooks/useProjectSwitcherPalette";

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

export interface SwitcherSection {
  key: string;
  label: string | null;
  isUserGroup: boolean;
  items: SearchableProject[];
}

export function buildSwitcherSections(
  results: SearchableProject[],
  groups: ProjectGroup[]
): SwitcherSection[] {
  const sortedGroups = [...groups].sort((a, b) => a.order - b.order);
  const groupedProjectIds = new Set<string>();
  const sections: SwitcherSection[] = [];

  for (const group of sortedGroups) {
    const items = group.projectIds
      .map((pid) => results.find((p) => p.id === pid))
      .filter((p): p is SearchableProject => p !== undefined);
    if (items.length === 0) continue;
    for (const item of items) groupedProjectIds.add(item.id);
    sections.push({
      key: group.id,
      label: group.name,
      isUserGroup: true,
      items,
    });
  }

  const ungrouped = results.filter((p) => !groupedProjectIds.has(p.id));
  const pinned = ungrouped.filter((p) => p.isPinned && !p.isActive);
  const current = ungrouped.filter((p) => p.isActive);
  const rest = ungrouped.filter((p) => !p.isActive && !p.isPinned);

  if (pinned.length > 0) {
    sections.push({ key: "pinned", label: "Pinned", isUserGroup: false, items: pinned });
  }
  if (current.length > 0) {
    sections.push({ key: "current", label: null, isUserGroup: false, items: current });
  }
  if (rest.length > 0) {
    sections.push({ key: "other", label: null, isUserGroup: false, items: rest });
  }

  return sections;
}
