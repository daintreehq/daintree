import { store } from "../store.js";
import { CHANNELS } from "../ipc/channels.js";
import { broadcastToRenderer } from "../ipc/utils.js";
import {
  isStorableAssistantAgentId,
  isStorableDefaultAgent,
  type AgentDefaultsLegacyCandidates,
  type AgentDefaultsPatch,
  type AgentDefaultsSnapshot,
} from "../../shared/types/ipc/agentDefaults.js";

type Leaf = keyof AgentDefaultsSnapshot;

const LEAVES: readonly Leaf[] = ["assistantAgentId", "defaultAgent"];

const LEAF_LOCATION: Record<Leaf, { slot: "helpAssistant" | "agentSettings"; field: string }> = {
  assistantAgentId: { slot: "helpAssistant", field: "agentId" },
  defaultAgent: { slot: "agentSettings", field: "defaultAgent" },
};

function isStorableLeaf(leaf: Leaf, value: unknown): boolean {
  if (value === null) return true;
  return leaf === "assistantAgentId"
    ? isStorableAssistantAgentId(value)
    : isStorableDefaultAgent(value);
}

function readSlot(leaf: Leaf): Record<string, unknown> | null {
  const raw = store.get(LEAF_LOCATION[leaf].slot) as unknown;
  return raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
}

function hasLeaf(leaf: Leaf): boolean {
  const slot = readSlot(leaf);
  return slot !== null && Object.hasOwn(slot, LEAF_LOCATION[leaf].field);
}

function writeLeaf(leaf: Leaf, value: string | null): void {
  const { slot, field } = LEAF_LOCATION[leaf];
  store.set(`${slot}.${field}` as never, value as never);
}

function deleteLeaf(leaf: Leaf): void {
  const { slot, field } = LEAF_LOCATION[leaf];
  store.delete(`${slot}.${field}` as never);
}

/**
 * The host's defaults. A leaf whose stored value no longer validates reads as
 * cleared rather than absent, so a corrupted value can't reopen migration.
 */
export function readAgentDefaults(): AgentDefaultsSnapshot {
  const out: AgentDefaultsSnapshot = {};
  for (const leaf of LEAVES) {
    if (!hasLeaf(leaf)) continue;
    const value = readSlot(leaf)?.[LEAF_LOCATION[leaf].field];
    (out as Record<Leaf, unknown>)[leaf] = isStorableLeaf(leaf, value) ? value : null;
  }
  return out;
}

function broadcast(): void {
  broadcastToRenderer(CHANNELS.AGENT_DEFAULTS_CHANGED, readAgentDefaults());
}

function sameLeaf(leaf: Leaf, value: unknown): boolean {
  return hasLeaf(leaf) && readSlot(leaf)?.[LEAF_LOCATION[leaf].field] === value;
}

/** Writes each valid leaf the patch names. Returns whether anything changed. */
export function setAgentDefaults(patch: AgentDefaultsPatch): boolean {
  if (!patch || typeof patch !== "object") return false;
  let changed = false;
  for (const leaf of LEAVES) {
    if (!Object.hasOwn(patch, leaf)) continue;
    const value = patch[leaf];
    if (value === undefined || !isStorableLeaf(leaf, value)) continue;
    if (sameLeaf(leaf, value)) continue;
    writeLeaf(leaf, value);
    changed = true;
  }
  if (changed) broadcast();
  return changed;
}

/**
 * One-time move of a machine's localStorage values onto this host. Each leaf
 * lands only if the host has never had one; a value already here, including an
 * explicit `null`, wins. Check and write share one synchronous turn, so two
 * views migrating at once can't both land (ipcMain handlers interleave only at
 * an `await`).
 */
export function migrateLegacyAgentDefaults(
  candidates: AgentDefaultsLegacyCandidates
): AgentDefaultsSnapshot {
  let changed = false;
  if (candidates && typeof candidates === "object") {
    for (const leaf of LEAVES) {
      if (!Object.hasOwn(candidates, leaf)) continue;
      const value = candidates[leaf];
      if (value === undefined || !isStorableLeaf(leaf, value)) continue;
      if (hasLeaf(leaf)) continue;
      writeLeaf(leaf, value);
      changed = true;
    }
  }
  if (changed) broadcast();
  return readAgentDefaults();
}

/**
 * Puts the defaults back exactly as a snapshot had them, presence included —
 * a leaf the snapshot lacks is deleted, so undoing an import onto a host that
 * never had a default leaves it eligible for migration again, as it was.
 */
export function restoreAgentDefaults(snapshot: AgentDefaultsSnapshot): void {
  const source = snapshot && typeof snapshot === "object" ? snapshot : {};
  let changed = false;
  for (const leaf of LEAVES) {
    const present = Object.hasOwn(source, leaf) && source[leaf] !== undefined;
    if (!present) {
      if (!hasLeaf(leaf)) continue;
      deleteLeaf(leaf);
      changed = true;
      continue;
    }
    const value = source[leaf]!;
    if (!isStorableLeaf(leaf, value) || sameLeaf(leaf, value)) continue;
    writeLeaf(leaf, value);
    changed = true;
  }
  if (changed) broadcast();
}
