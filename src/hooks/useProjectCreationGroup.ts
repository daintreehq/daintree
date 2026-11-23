import { useEffect, useRef, useState } from "react";
import type { ProjectGroup } from "@shared/types/project";
import { useProjectGroupsStore } from "@/store/projectGroupsStore";

export interface ProjectCreationGroup {
  /** Every group, in render order, live from the host. */
  groups: ProjectGroup[];
  /** The chosen group while it still exists, otherwise `null` for no group. */
  groupId: string | null;
  setGroupId: (groupId: string | null) => void;
  /**
   * Makes a new group and chooses it. Rejects with the host's message (an
   * empty or duplicate name) for the name dialog to show.
   */
  createGroup: (name: string) => Promise<void>;
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
  // Which opening a choice belongs to. A group made just before the dialog
  // closed, or was pointed at another folder, still exists once the host
  // answers, but choosing it then would overwrite the fresh start.
  const openingRef = useRef(0);

  useEffect(() => {
    if (isOpen) useProjectGroupsStore.getState().init();
  }, [isOpen]);

  useEffect(() => {
    openingRef.current += 1;
    if (isOpen) setChosen(seed ?? null);
  }, [isOpen, seed, resetKey]);

  const createGroup = async (name: string) => {
    const opening = openingRef.current;
    const group = await useProjectGroupsStore.getState().createGroup(name);
    if (openingRef.current === opening) setChosen(group.id);
  };

  const groupId = chosen !== null && groups.some((group) => group.id === chosen) ? chosen : null;
  return { groups, groupId, setGroupId: setChosen, createGroup };
}
