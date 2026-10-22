import { parseProjectPluginInstanceKey } from "../types/plugin.js";

/**
 * How a project arranges its launcher (#13791), beside the two launcher
 * features in `presentationProfile.ts` that demote built-in groups into More.
 *
 * Groups are named `agents`, `panels`, `recipes` and `plugin:{pluginId}`, the
 * plugin's instance id: the user's order is stored on this machine, per
 * project, so the machine-local half of a project plugin's key is safe there,
 * and it is how the project's hidden groups already name plugins.
 *
 * A featured entry is named `{publisher.name}.{entry id}`, without the project
 * half, because a repository suggests it and cannot know this machine's
 * project id. Only the project's own plugin's entries can be featured.
 */
export const LAUNCHER_BUILT_IN_GROUPS = ["agents", "panels", "recipes"] as const;
export type LauncherBuiltInGroupId = (typeof LAUNCHER_BUILT_IN_GROUPS)[number];

const PLUGIN_GROUP_PREFIX = "plugin:";

/** Most groups a stored order may name; the file is user-editable, so it is bounded on read too. */
export const MAX_LAUNCHER_GROUP_ORDER = 200;
/** A plugin instance id is at most 300 characters (see `projectHiddenLaunchGroups.ts`), plus the prefix. */
export const MAX_LAUNCHER_GROUP_ID_LENGTH = 320;

export function launcherPluginGroupId(pluginId: string): string {
  return `${PLUGIN_GROUP_PREFIX}${pluginId}`;
}

function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

export function isLauncherGroupId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_LAUNCHER_GROUP_ID_LENGTH &&
    !hasControlCharacter(value)
  );
}

/**
 * Deduped and bounded. Ids this build does not draw — a plugin that is gone
 * for now, a group a newer build added — are kept, so the order holds when
 * they come back.
 */
export function parseLauncherGroupOrder(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set<string>();
  for (const id of value) {
    if (ids.size >= MAX_LAUNCHER_GROUP_ORDER) break;
    if (isLauncherGroupId(id)) ids.add(id);
  }
  return [...ids];
}

/**
 * The order to store after the user reorders the groups drawn right now.
 * Groups the stored order names but nothing draws — a plugin unloaded or
 * hidden for now — keep their place, each after the drawn group it followed,
 * so one coming back lands where the user put it.
 */
export function mergeLauncherGroupOrder(
  drawn: readonly string[],
  stored: readonly string[]
): string[] {
  const shown = new Set(drawn);
  const after = new Map<string | null, string[]>();
  let anchor: string | null = null;
  for (const id of stored) {
    if (shown.has(id)) {
      anchor = id;
    } else {
      after.set(anchor, [...(after.get(anchor) ?? []), id]);
    }
  }
  return [...(after.get(null) ?? []), ...drawn.flatMap((id) => [id, ...(after.get(id) ?? [])])];
}

/** Plugin groups in the launcher's stock order: by name, so a plugin can't buy its way up. */
export function compareLauncherPluginGroups(
  a: { pluginId: string; pluginName: string },
  b: { pluginId: string; pluginName: string }
): number {
  return a.pluginName.localeCompare(b.pluginName) || a.pluginId.localeCompare(b.pluginId);
}

/** The stock group order for these plugin groups, already in stock order themselves. */
export function stockLauncherGroupOrder(pluginGroupIds: readonly string[]): string[] {
  return ["agents", "panels", ...pluginGroupIds, "recipes"];
}

/**
 * The order the launcher draws its groups in. The user's order wins; groups it
 * does not name follow the profile's order, where the project's own plugin
 * groups lead once the profile arranges the launcher, and otherwise stock.
 */
export function resolveLauncherGroupOrder({
  stock,
  leading,
  arranged,
  userOrder,
}: {
  /** Every group the launcher has, in stock order. */
  stock: readonly string[];
  /** The groups that lead while the profile arranges the launcher. */
  leading: readonly string[];
  arranged: boolean;
  userOrder: readonly string[];
}): string[] {
  const present = new Set(stock);
  const lead = arranged ? leading.filter((id) => present.has(id)) : [];
  const profile = [...lead, ...stock.filter((id) => !lead.includes(id))];
  const named = [...new Set(userOrder)].filter((id) => present.has(id));
  return [...named, ...profile.filter((id) => !named.includes(id))];
}

/** How a project arranges its launcher, resolved for one view. */
export interface LauncherArrangement {
  /** The view's own project once its profile has loaded, else `null`. */
  projectId: string | null;
  /** Built-in groups the profile folds into More. */
  demoted: { agents: boolean; panels: boolean };
  /** The user's group order; groups it does not name follow the profile. */
  groupOrder: readonly string[];
  /** The project plugin entry to preselect, `{publisher.name}.{entry id}`. */
  featuredEntry: string | null;
}

export const STOCK_LAUNCHER_ARRANGEMENT: LauncherArrangement = {
  projectId: null,
  demoted: { agents: false, panels: false },
  groupOrder: [],
  featuredEntry: null,
};

/**
 * Which groups the launcher draws, in order, and which of them fold into More.
 * The profile arranges the launcher once it demotes a group or features an
 * entry; then the project's own plugin groups lead. The user's order wins over
 * both. Demoting moves a group, never removes it.
 */
export function arrangeLauncherGroups(
  pluginGroups: ReadonlyArray<{ pluginId: string }>,
  arrangement: LauncherArrangement,
  hasRows: (groupId: string) => boolean = () => true
): { shown: string[]; demoted: string[]; fixedOrder: boolean } {
  const arranged =
    arrangement.demoted.agents || arrangement.demoted.panels || arrangement.featuredEntry !== null;
  const order = resolveLauncherGroupOrder({
    stock: stockLauncherGroupOrder(
      pluginGroups.map((group) => launcherPluginGroupId(group.pluginId))
    ),
    leading: pluginGroups
      .filter((group) => isOwnProjectPlugin(group.pluginId, arrangement.projectId))
      .map((group) => launcherPluginGroupId(group.pluginId)),
    arranged,
    userOrder: arrangement.groupOrder,
  });
  const isDemoted = (id: string) =>
    (id === "agents" && arrangement.demoted.agents) ||
    (id === "panels" && arrangement.demoted.panels);
  return {
    shown: order.filter((id) => !isDemoted(id)),
    demoted: order.filter((id) => isDemoted(id) && hasRows(id)),
    fixedOrder: arranged || arrangement.groupOrder.length > 0,
  };
}

const MANIFEST_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*\.[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ENTRY_ID_PATTERN = /^[a-zA-Z0-9._-]{1,64}$/;
/** A manifest name is at most 64 characters and an entry id at most 64, joined by a dot. */
export const MAX_FEATURED_LAUNCH_ENTRY_LENGTH = 129;

/**
 * Whether `value` is shaped like a featured entry, `{publisher.name}.{entry
 * id}`. Neither half of a manifest name holds a dot, so the first two
 * segments are the plugin and the rest — which may hold dots — the entry.
 */
export function isFeaturedLaunchEntryRef(value: unknown): value is string {
  if (typeof value !== "string" || value.length > MAX_FEATURED_LAUNCH_ENTRY_LENGTH) return false;
  const [publisher = "", name = "", ...entry] = value.split(".");
  return MANIFEST_ID_PATTERN.test(`${publisher}.${name}`) && ENTRY_ID_PATTERN.test(entry.join("."));
}

/**
 * The featured reference for a launch entry, or null when it is not an entry
 * of a project plugin — of `projectId`'s, when that is given.
 */
export function featuredRefForLaunchEntry(
  entry: { id: string; pluginId: string },
  projectId?: string | null
): string | null {
  const owner = parseProjectPluginInstanceKey(entry.pluginId);
  if (owner === null || (projectId != null && owner.projectId !== projectId)) return null;
  if (!entry.id.startsWith(`${entry.pluginId}.`)) return null;
  const ref = `${owner.manifestId}.${entry.id.slice(entry.pluginId.length + 1)}`;
  return isFeaturedLaunchEntryRef(ref) ? ref : null;
}

/** Whether `pluginId` is a plugin `projectId` itself loads, the only kind whose group may lead. */
export function isOwnProjectPlugin(pluginId: string, projectId: string | null): boolean {
  const owner = parseProjectPluginInstanceKey(pluginId);
  return owner !== null && projectId !== null && owner.projectId === projectId;
}
