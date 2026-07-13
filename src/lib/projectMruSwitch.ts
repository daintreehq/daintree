import { useProjectStore } from "@/store/projectStore";
import type { Project } from "@shared/types";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { getMruProjects } from "@shared/utils/projectMru";

import { notify } from "./notify";

export type ProjectMruCycleDirection = "older" | "newer";

export function getProjectMruSwitchTarget(
  projects: readonly Project[],
  currentProjectId: string | null | undefined,
  direction: ProjectMruCycleDirection
): Project | null {
  const sorted = getMruProjects(projects);

  // A scratch workspace clears `currentProject` without touching any project's
  // `lastOpened`, so the project used just before the scratch is still the MRU
  // head. With nothing to excise, the same circular walk over the full list
  // lands "older" on it and "newer" on the tail.
  if (!currentProjectId) {
    return (direction === "older" ? sorted[0] : sorted.at(-1)) ?? null;
  }

  const current = sorted.find((project) => project.id === currentProjectId);
  if (!current) return null;

  const otherProjects = sorted.filter((project) => project.id !== current.id);
  if (otherProjects.length === 0) return null;

  return direction === "older" ? (otherProjects[0] ?? null) : (otherProjects.at(-1) ?? null);
}

async function switchProjectById(targetId: string): Promise<void> {
  const state = useProjectStore.getState();
  const target = state.projects.find((project) => project.id === targetId);
  if (!target) return;
  if (state.currentProject?.id === target.id) return;

  const switchFn = target.status === "background" ? state.reopenProject : state.switchProject;
  await switchFn(target.id);
}

export async function switchProjectByMruDirection(
  direction: ProjectMruCycleDirection
): Promise<void> {
  const state = useProjectStore.getState();
  const target = getProjectMruSwitchTarget(
    state.projects,
    state.currentProject?.id ?? null,
    direction
  );
  if (!target) return;

  const targetId = target.id;
  try {
    await switchProjectById(targetId);
  } catch (error) {
    notify({
      type: "error",
      title: "Couldn't switch project",
      message: formatErrorMessage(error, "Couldn't switch project"),
      actions: [
        {
          label: "Try again",
          variant: "primary",
          onClick: () => {
            void switchProjectById(targetId);
          },
        },
      ],
    });
  }
}
