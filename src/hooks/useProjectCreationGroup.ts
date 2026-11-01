import { useEffect, useState } from "react";
import type { ProjectGroup } from "@shared/types/project";
import { useProjectGroupsStore } from "@/store/projectGroupsStore";

export interface ProjectCreationGroup {
  /** Every group, in render order, live from the host. */
  groups: ProjectGroup[];
  /** The chosen group while it still exists, otherwise `null` for no group. */
  groupId: string | null;
  setGroupId: (groupId: string | null) => void;
}

/**
 * The group a project-creation dialog files its new project under.
 *
 * The choice starts over each time the dialog opens: no group, or `seed` when
 * an earlier dialog in the same flow already asked. `resetKey` starts it over
 * again when the dialog is pointed at something else while open. `groupId` is
 * checked against the live list on every render rather than cleared by an
 * effect, so a group deleted while the dialog is open reads as no group at
 * once and can never be submitted in the gap.
 */
export function useProjectCreationGroup(
  isOpen: boolean,
  seed?: string | null,
  resetKey?: string
): ProjectCreationGroup {
  const groups = useProjectGroupsStore((state) => state.groups);
  const [chosen, setChosen] = useState<string | null>(seed ?? null);

  useEffect(() => {
    if (isOpen) useProjectGroupsStore.getState().init();
  }, [isOpen]);

  useEffect(() => {
    if (isOpen) setChosen(seed ?? null);
  }, [isOpen, seed, resetKey]);

  const groupId = chosen !== null && groups.some((group) => group.id === chosen) ? chosen : null;
  return { groups, groupId, setGroupId: setChosen };
}
