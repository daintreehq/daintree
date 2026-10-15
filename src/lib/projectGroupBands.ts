import type { ProjectGroup } from "@shared/types/project";

/**
 * A user-made group's band in the project switcher. Namespaced so a group can
 * never collide with a built-in band key in the shared collapse map, whatever
 * id it was minted with.
 */
export type ProjectGroupBandKey = `group:${string}`;

export function groupBandKey(groupId: string): ProjectGroupBandKey {
  return `group:${groupId}`;
}

export function isGroupBandKey(key: string): key is ProjectGroupBandKey {
  return key.startsWith("group:");
}

export function groupIdOfBandKey(key: ProjectGroupBandKey): string {
  return key.slice("group:".length);
}

/**
 * Groups in render order. Position is the primary key; creation time and id
 * break ties so two writers racing to the same slot can never make the order
 * flip between renders.
 */
export function sortProjectGroups(groups: readonly ProjectGroup[]): ProjectGroup[] {
  return [...groups].sort(
    (a, b) => a.position - b.position || a.createdAt - b.createdAt || a.id.localeCompare(b.id)
  );
}
