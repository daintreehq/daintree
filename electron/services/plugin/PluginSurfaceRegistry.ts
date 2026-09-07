import type { ProjectSurfaceClaim, ProjectSurfaceSlot } from "../../../shared/types/plugin.js";

/**
 * Who owns each project surface slot (§7.8).
 *
 * A surface claim is the one plugin contribution that *replaces* something the
 * host already draws, so it needs an arbiter the other contribution points do
 * not: two panels of the same name coexist, two empty canvases cannot. This is
 * that arbiter — one owner per `(projectId, slot)`, first claim wins, and a
 * second claimant is reported by name rather than silently overwriting the
 * first.
 *
 * A refused claimant is REMEMBERED, not discarded. It stays loaded and its
 * declaration stays valid, so when the incumbent unloads (uninstalled, trust
 * revoked, or edited to drop the claim) the slot passes to it instead of
 * reverting to stock for as long as the app runs — nothing would ever retry it,
 * because a loaded plugin is not scanned again.
 *
 * Module-level for the same reason `PluginContributionBroadcaster`'s scope
 * index is: the registries it sits beside (`panelKindRegistry` and friends) are
 * module singletons, and a per-service instance would disagree with them.
 *
 * Keyed by project rather than global: a claim is meaningless without the
 * project it reshapes, and reading one for the wrong project is the leak
 * project scope exists to prevent.
 */
type SlotClaimants = Map<ProjectSurfaceSlot, ProjectSurfaceClaim[]>;

/** `projectId → slot → claimants, owner first, in claim order.` */
const CLAIMS_BY_PROJECT = new Map<string, SlotClaimants>();

/** Reverse index so an unload can release a plugin's claims without a scan. */
const CLAIMED_BY_PLUGIN = new Map<string, Array<{ projectId: string; slot: ProjectSurfaceSlot }>>();

/** The outcome of one slot claim, so the caller can report a refusal. */
export type SurfaceClaimResult =
  | { ok: true }
  | {
      ok: false;
      /** The plugin that already owns the slot — named in the caller's error. */
      heldBy: string;
    };

/**
 * Claim `slot` in `projectId` for `claim.pluginId`.
 *
 * Idempotent for the SAME plugin: a reload re-registers its own claim over
 * itself, whether it owns the slot or is queued behind someone else. A
 * different plugin is refused and the incumbent is returned, because the
 * alternative — last write wins — makes which surface the user sees a function
 * of directory-scan order.
 */
export function claimProjectSurface(
  projectId: string,
  slot: ProjectSurfaceSlot,
  claim: ProjectSurfaceClaim
): SurfaceClaimResult {
  if (projectId.length === 0) {
    throw new TypeError("claimProjectSurface: projectId must be a non-empty string");
  }
  const slots = CLAIMS_BY_PROJECT.get(projectId) ?? (new Map() as SlotClaimants);
  const claimants = slots.get(slot) ?? [];
  const existing = claimants.findIndex((entry) => entry.pluginId === claim.pluginId);
  if (existing >= 0) {
    // Same plugin, refreshed panel-kind id (a reload mints a new view
    // generation). Keep its position in the queue.
    claimants[existing] = claim;
  } else {
    claimants.push(claim);
  }
  slots.set(slot, claimants);
  CLAIMS_BY_PROJECT.set(projectId, slots);

  const owned = CLAIMED_BY_PLUGIN.get(claim.pluginId) ?? [];
  if (!owned.some((entry) => entry.projectId === projectId && entry.slot === slot)) {
    owned.push({ projectId, slot });
  }
  CLAIMED_BY_PLUGIN.set(claim.pluginId, owned);

  const owner = claimants[0];
  return owner !== undefined && owner.pluginId !== claim.pluginId
    ? { ok: false, heldBy: owner.pluginId }
    : { ok: true };
}

/**
 * Every slot claimed in one project, as its owner. The renderer's snapshot, and
 * the only read path — there is deliberately no "current project" lookup, so a
 * caller that has not resolved a project cannot accidentally read another's
 * surfaces.
 */
export function getProjectSurfaces(
  projectId: string | null | undefined
): Partial<Record<ProjectSurfaceSlot, ProjectSurfaceClaim>> {
  if (projectId === null || projectId === undefined || projectId.length === 0) return {};
  const slots = CLAIMS_BY_PROJECT.get(projectId);
  if (slots === undefined) return {};
  const snapshot: Partial<Record<ProjectSurfaceSlot, ProjectSurfaceClaim>> = {};
  for (const [slot, claimants] of slots) {
    const owner = claimants[0];
    if (owner !== undefined) snapshot[slot] = owner;
  }
  return snapshot;
}

/**
 * Drop every claim held by `pluginId`, promoting the next claimant in each slot
 * it owned.
 *
 * Called from the unload cascade and by a trust revoke, which unloads through
 * the same path — a surface must not outlive the plugin that drew it, or the
 * project is left rendering a view whose module can no longer be imported.
 *
 * Returns the projects whose OWNER changed, so the caller can push a fresh
 * snapshot to exactly those views; dropping a queued claimant changes nothing
 * anyone can see and reports nothing.
 */
export function releasePluginSurfaces(pluginId: string): string[] {
  const owned = CLAIMED_BY_PLUGIN.get(pluginId);
  if (owned === undefined) return [];
  CLAIMED_BY_PLUGIN.delete(pluginId);
  const touched = new Set<string>();
  for (const { projectId, slot } of owned) {
    const slots = CLAIMS_BY_PROJECT.get(projectId);
    const claimants = slots?.get(slot);
    if (slots === undefined || claimants === undefined) continue;
    const wasOwner = claimants[0]?.pluginId === pluginId;
    const remaining = claimants.filter((entry) => entry.pluginId !== pluginId);
    if (remaining.length === 0) {
      slots.delete(slot);
    } else {
      slots.set(slot, remaining);
    }
    if (wasOwner) touched.add(projectId);
    if (slots.size === 0) CLAIMS_BY_PROJECT.delete(projectId);
  }
  return [...touched];
}

/** Reset every claim. Test isolation and full plugin-host disposal. */
export function clearAllProjectSurfaces(): void {
  CLAIMS_BY_PROJECT.clear();
  CLAIMED_BY_PLUGIN.clear();
}
