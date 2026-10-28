import {
  pluginManifestIdFromInstanceKey,
  projectSurfaceSlotDescriptor,
  type ProjectSurfaceRefusal,
  type ProjectSurfaceRefusalReason,
  type ProjectSurfaceSlotKey,
  type ProjectSurfaceSlotClaim,
  type ProjectSurfaceSlotMode,
  type ProjectSurfaceSlotState,
} from "../../../shared/types/plugin.js";

/**
 * Who holds each project slot (§7.8).
 *
 * A slot claim is the one plugin contribution that *replaces* something the
 * host already draws, so it needs an arbiter the other contribution points do
 * not: two panels of the same name coexist, two empty canvases cannot. This is
 * that arbiter, for every slot in `PROJECT_SURFACE_SLOT_CATALOGUE` and every
 * file editor slot, which is keyed by the pattern it is about.
 *
 * Arbitration is a pure function of the claims present, never of the order
 * they arrived in. A claim is stored against its plugin, with no queue
 * position, and every read re-ranks the full set. So a dev reload of the owner
 * — which releases its claim on unload and makes it again on load — hands the
 * slot back to the same plugin instead of to whoever was waiting behind it.
 *
 * A losing claim is REMEMBERED, not discarded. It stays loaded and its
 * declaration stays valid, so when the winner unloads the slot passes to it
 * instead of reverting to stock for as long as the app runs — nothing would
 * ever retry it, because a loaded plugin is not scanned again. Losing claims
 * and claims the host could not apply are both reported as refusals, attributed
 * to the plugin, so the user and its author can see why it is not showing.
 *
 * Module-level for the same reason `PluginContributionBroadcaster`'s scope
 * index is: the registries it sits beside (`panelKindRegistry` and friends) are
 * module singletons, and a per-service instance would disagree with them.
 *
 * Keyed by project rather than global: a claim is meaningless without the
 * project it reshapes, and reading one for the wrong project is the leak
 * project scope exists to prevent.
 */
type ByPlugin<T> = Map<string, T>;
type BySlot<T> = Map<ProjectSurfaceSlotKey, ByPlugin<T>>;

/** `projectId → slot → pluginId → claim`. */
const CLAIMS = new Map<string, BySlot<ProjectSurfaceSlotClaim>>();

/** Claims the host could not apply at all: `projectId → slot → pluginId → refusal`. */
const REJECTED = new Map<string, BySlot<ProjectSurfaceRefusal>>();

/** Reverse index so an unload can release a plugin's entries without a scan. */
const ENTRIES_BY_PLUGIN = new Map<
  string,
  Array<{ projectId: string; slot: ProjectSurfaceSlotKey }>
>();

/**
 * Per-project revision, bumped on every change. Drawn from one app-wide counter
 * so a project's revision never repeats even after its last claim is gone.
 */
const REVISIONS = new Map<string, number>();
let lastRevision = 0;

/** The outcome of one slot claim, so the caller can report a refusal. */
export type SurfaceClaimResult =
  | {
      ok: true;
      /** The plugin that held the slot until this claim outranked it. */
      displaced?: string;
    }
  | {
      ok: false;
      reason: ProjectSurfaceRefusalReason;
      /** For `outranked`, the plugin holding the slot — named in the caller's error. */
      heldBy?: string;
    };

/** Project plugins first, then manifest id, then instance key. Locale-independent. */
function compareClaims(a: ProjectSurfaceSlotClaim, b: ProjectSurfaceSlotClaim): number {
  if (a.scope !== b.scope) return a.scope === "project" ? -1 : 1;
  const byManifest = compareIds(
    pluginManifestIdFromInstanceKey(a.pluginId),
    pluginManifestIdFromInstanceKey(b.pluginId)
  );
  return byManifest !== 0 ? byManifest : compareIds(a.pluginId, b.pluginId);
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Rank one slot's claims. Pure: the same set of claims gives the same state
 * whatever order they arrived in.
 *
 * Exclusive: the highest-ranked project claim owns the slot and every other
 * claim is refused. Selectable: every claim is an option, and the
 * highest-ranked PROJECT claim is the default — an installed option shows only
 * once the user picks it, because its default would change every project at
 * once.
 */
export function arbitrateProjectSurfaceSlot(
  slot: ProjectSurfaceSlotKey,
  mode: ProjectSurfaceSlotMode,
  claims: Iterable<ProjectSurfaceSlotClaim>
): ProjectSurfaceSlotState {
  const ranked = [...claims].sort(compareClaims);
  const fallback = ranked.find((claim) => claim.scope === "project");
  if (mode === "selectable") {
    return {
      mode,
      options: ranked,
      defaultOptionId: fallback?.pluginId ?? null,
      refused: [],
    };
  }
  const refused: ProjectSurfaceRefusal[] = [];
  for (const claim of ranked) {
    if (claim === fallback) continue;
    refused.push(
      claim.scope === "installed"
        ? { slot, pluginId: claim.pluginId, reason: "installed-exclusive" }
        : { slot, pluginId: claim.pluginId, reason: "outranked", heldBy: fallback?.pluginId }
    );
  }
  return {
    mode,
    options: fallback === undefined ? [] : [fallback],
    defaultOptionId: fallback?.pluginId ?? null,
    refused,
  };
}

function bump(projectId: string): void {
  lastRevision += 1;
  REVISIONS.set(projectId, lastRevision);
}

function track(pluginId: string, projectId: string, slot: ProjectSurfaceSlotKey): void {
  const entries = ENTRIES_BY_PLUGIN.get(pluginId) ?? [];
  if (!entries.some((entry) => entry.projectId === projectId && entry.slot === slot)) {
    entries.push({ projectId, slot });
  }
  ENTRIES_BY_PLUGIN.set(pluginId, entries);
}

function slotMap<T>(
  table: Map<string, BySlot<T>>,
  projectId: string,
  slot: ProjectSurfaceSlotKey
): ByPlugin<T> {
  const slots = table.get(projectId) ?? (new Map() as BySlot<T>);
  table.set(projectId, slots);
  const byPlugin = slots.get(slot) ?? new Map<string, T>();
  slots.set(slot, byPlugin);
  return byPlugin;
}

function deleteEntry<T>(
  table: Map<string, BySlot<T>>,
  projectId: string,
  slot: ProjectSurfaceSlotKey,
  pluginId: string
): void {
  const slots = table.get(projectId);
  const byPlugin = slots?.get(slot);
  if (slots === undefined || byPlugin === undefined) return;
  byPlugin.delete(pluginId);
  if (byPlugin.size === 0) slots.delete(slot);
  if (slots.size === 0) table.delete(projectId);
}

function requireProjectId(projectId: string, caller: string): void {
  if (projectId.length === 0) {
    throw new TypeError(`${caller}: projectId must be a non-empty string`);
  }
}

function slotState(projectId: string, slot: ProjectSurfaceSlotKey): ProjectSurfaceSlotState | null {
  const claims = CLAIMS.get(projectId)?.get(slot);
  const rejected = REJECTED.get(projectId)?.get(slot);
  if (claims === undefined && rejected === undefined) return null;
  const state = arbitrateProjectSurfaceSlot(
    slot,
    projectSurfaceSlotDescriptor(slot).mode,
    claims?.values() ?? []
  );
  if (rejected !== undefined) {
    const extra = [...rejected.values()].sort((a, b) => compareIds(a.pluginId, b.pluginId));
    state.refused.push(...extra);
  }
  return state;
}

/**
 * Claim `slot` in `projectId` for `claim.pluginId`.
 *
 * Idempotent for the SAME plugin: a reload re-registers its claim over its own,
 * and wins or loses exactly as it did before. A claim carrying the wrong kind
 * for the slot (a view where it takes data, or the reverse) is refused and
 * remembered as a refusal rather than applied.
 *
 * The claim is copied, so a caller mutating its data afterwards cannot reach
 * into the registry.
 */
export function claimProjectSurface(
  projectId: string,
  slot: ProjectSurfaceSlotKey,
  claim: ProjectSurfaceSlotClaim
): SurfaceClaimResult {
  requireProjectId(projectId, "claimProjectSurface");
  const before = slotState(projectId, slot)?.defaultOptionId ?? null;
  track(claim.pluginId, projectId, slot);
  bump(projectId);

  if (claim.value.kind !== projectSurfaceSlotDescriptor(slot).claim) {
    deleteEntry(CLAIMS, projectId, slot, claim.pluginId);
    slotMap(REJECTED, projectId, slot).set(claim.pluginId, {
      slot,
      pluginId: claim.pluginId,
      reason: "claim-kind",
    });
    return { ok: false, reason: "claim-kind" };
  }

  deleteEntry(REJECTED, projectId, slot, claim.pluginId);
  slotMap(CLAIMS, projectId, slot).set(claim.pluginId, structuredClone(claim));

  const state = slotState(projectId, slot);
  const refusal = state?.refused.find((entry) => entry.pluginId === claim.pluginId);
  if (refusal !== undefined) {
    return { ok: false, reason: refusal.reason, heldBy: refusal.heldBy };
  }
  return before !== null && before !== claim.pluginId && state?.mode === "exclusive"
    ? { ok: true, displaced: before }
    : { ok: true };
}

/**
 * Record that `pluginId` declared a claim on `slot` the host could not apply —
 * a view that registered nothing mountable — so the refusal is visible instead
 * of the slot silently keeping its stock content. Drops any claim the plugin
 * held on the slot, since it no longer describes something that can render.
 */
export function refuseProjectSurface(
  projectId: string,
  slot: ProjectSurfaceSlotKey,
  pluginId: string,
  reason: Exclude<ProjectSurfaceRefusalReason, "outranked" | "installed-exclusive">
): void {
  requireProjectId(projectId, "refuseProjectSurface");
  track(pluginId, projectId, slot);
  bump(projectId);
  deleteEntry(CLAIMS, projectId, slot, pluginId);
  slotMap(REJECTED, projectId, slot).set(pluginId, { slot, pluginId, reason });
}

/**
 * Every slot claimed in one project, arbitrated. The renderer's snapshot, and
 * the only read path — there is deliberately no "current project" lookup, so a
 * caller that has not resolved a project cannot accidentally read another's
 * slots. Detached: nothing the caller does to it reaches the registry.
 */
export function getProjectSurfaceSlots(
  projectId: string | null | undefined
): Partial<Record<ProjectSurfaceSlotKey, ProjectSurfaceSlotState>> {
  if (projectId === null || projectId === undefined || projectId.length === 0) return {};
  const slots = new Set<ProjectSurfaceSlotKey>([
    ...(CLAIMS.get(projectId)?.keys() ?? []),
    ...(REJECTED.get(projectId)?.keys() ?? []),
  ]);
  const snapshot: Partial<Record<ProjectSurfaceSlotKey, ProjectSurfaceSlotState>> = {};
  for (const slot of slots) {
    const state = slotState(projectId, slot);
    if (state !== null) snapshot[slot] = structuredClone(state);
  }
  return snapshot;
}

/** Every refusal in one project, across its slots. */
export function getProjectSurfaceRefusals(
  projectId: string | null | undefined
): ProjectSurfaceRefusal[] {
  return Object.values(getProjectSurfaceSlots(projectId)).flatMap((state) => state?.refused ?? []);
}

/** The project's current revision; `0` before anything has touched it. */
export function getProjectSurfaceRevision(projectId: string): number {
  return REVISIONS.get(projectId) ?? 0;
}

/**
 * Bump a project's revision for a change the registry does not see — the
 * user's answer — so views order it against claims like any other.
 */
export function bumpProjectSurfaceRevision(projectId: string): number {
  requireProjectId(projectId, "bumpProjectSurfaceRevision");
  bump(projectId);
  return lastRevision;
}

/**
 * Drop every claim and refusal held by `pluginId`, letting the next claimant in
 * each slot take over.
 *
 * Called from the unload cascade and by a trust revoke, which unloads through
 * the same path — a surface must not outlive the plugin that drew it, or the
 * project is left rendering a view whose module can no longer be imported.
 *
 * Returns every project whose slot state changed, so the caller can tell
 * exactly those views. A losing claimant leaving changes what they show too:
 * its refusal disappears.
 */
export function releasePluginSurfaces(pluginId: string): string[] {
  const entries = ENTRIES_BY_PLUGIN.get(pluginId);
  if (entries === undefined) return [];
  ENTRIES_BY_PLUGIN.delete(pluginId);
  const touched = new Set<string>();
  for (const { projectId, slot } of entries) {
    deleteEntry(CLAIMS, projectId, slot, pluginId);
    deleteEntry(REJECTED, projectId, slot, pluginId);
    touched.add(projectId);
  }
  for (const projectId of touched) bump(projectId);
  return [...touched];
}

/** Reset every claim, refusal and revision. Test isolation and full plugin-host disposal. */
export function clearAllProjectSurfaces(): void {
  CLAIMS.clear();
  REJECTED.clear();
  ENTRIES_BY_PLUGIN.clear();
  REVISIONS.clear();
  lastRevision = 0;
}
