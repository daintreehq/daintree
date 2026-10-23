import type { PluginViewHostKind } from "@shared/types/plugin";
import { applyExtensionStatePatch } from "@shared/utils/extensionState";
import {
  decodePanelExtensionState,
  type PanelExtensionStateDecode,
} from "@shared/utils/panelExtensionState";
import { logWarn } from "@/utils/logger";

/**
 * Durable `persistState` for plugin views mounted outside the panel grid — a
 * project surface (Home), a sidebar view, a settings section, a toolbar popover
 * (#14095). A panel keeps its bag on its panel record; these hosts have none,
 * so before this their state lasted only until the view unmounted, and leaving
 * Home for the grid or switching sidebar views threw the user's place away.
 *
 * The bag lives in the renderer's `localStorage`. Every project view shares the
 * `persist:daintree` session, so it outlives the view's own renderer (eviction,
 * Sleep, a renderer crash) and the app. A write has left the renderer when it
 * returns — Chromium commits it to disk shortly after — so what a view's
 * `persistState` accepted is what the next mount reads back, short of the whole
 * app dying in that moment. The bag
 * follows the same rules a panel's does — the 64KB cap, JSON canonicalisation,
 * merge-patch semantics and the plugin's declared `stateVersion` — through the
 * same shared helpers.
 *
 * Only what a view hands `persistState` is stored. Nothing here reads a form,
 * a settings value or a worker reply on the view's behalf, and the bag is
 * plaintext: secrets belong in the plugin's secret settings, never here.
 */

/** Bumped only if the envelope's own shape changes; the plugin's schema is `version`. */
const ENVELOPE_SCHEMA = 1;

export const PLUGIN_VIEW_STATE_KEY_PREFIX = "daintree:plugin-view-state:";

/**
 * Bags kept across every project and plugin before the least recently written
 * is dropped. The state is the kind a view can rebuild — a tab, a filter, a
 * half-filled form — so a bound keeps a plugin that mints a view key per item
 * from growing the store forever.
 */
export const MAX_PLUGIN_VIEW_STATE_ENTRIES = 200;

/**
 * Where a view's state belongs. Two mounts with the same identity are the same
 * view — the Home surface reopened, a sidebar view switched back to — and two
 * with different identities never see each other's state.
 */
export interface PluginViewStateIdentity {
  /** `"local"`, or the remote host the window belongs to. */
  hostId: string;
  /** The project or scratch workspace, or `"user"` for state that follows the user. */
  workspaceId: string;
  /** The plugin's runtime instance key. */
  pluginId: string;
  host: Exclude<PluginViewHostKind, "panel">;
  /** The host's stable name for the mount (its `mountId`). */
  viewKey: string;
}

interface Envelope {
  schema: number;
  version?: number;
  savedAt: number;
  state: Record<string, unknown>;
}

type Stored =
  | { kind: "empty" }
  | { kind: "future"; savedAt: number }
  | { kind: "ok"; envelope: Envelope; savedAt: number };

export function pluginViewStateKey(identity: PluginViewStateIdentity): string {
  const parts = [
    identity.hostId,
    identity.workspaceId,
    identity.pluginId,
    identity.host,
    identity.viewKey,
  ];
  return PLUGIN_VIEW_STATE_KEY_PREFIX + parts.map(encodeURIComponent).join(":");
}

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseEnvelope(raw: string): Stored | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || typeof parsed.schema !== "number") return null;
  const savedAt = typeof parsed.savedAt === "number" ? parsed.savedAt : 0;
  // Written by a newer build of the app: neither read nor overwritten, but
  // aged by its own write time so a downgrade doesn't make it the first to go.
  if (parsed.schema > ENVELOPE_SCHEMA) return { kind: "future", savedAt };
  if (!isRecord(parsed.state)) return null;
  const version =
    typeof parsed.version === "number" && Number.isInteger(parsed.version) && parsed.version >= 0
      ? parsed.version
      : undefined;
  return {
    kind: "ok",
    savedAt,
    envelope: { schema: ENVELOPE_SCHEMA, version, savedAt, state: parsed.state },
  };
}

function readStored(store: Storage, key: string): Stored {
  let raw: string | null;
  try {
    raw = store.getItem(key);
  } catch {
    return { kind: "empty" };
  }
  if (raw === null) return { kind: "empty" };
  const stored = parseEnvelope(raw);
  if (stored) return stored;
  // Unreadable bytes help nobody and would block every later write.
  try {
    store.removeItem(key);
  } catch {
    // Nothing to do: the next read will try again.
  }
  return { kind: "empty" };
}

/** Every stored bag's key, oldest write first. */
function keysOldestFirst(store: Storage): string[] {
  const entries: Array<{ key: string; savedAt: number }> = [];
  for (let i = 0; i < store.length; i++) {
    const key = store.key(i);
    if (!key?.startsWith(PLUGIN_VIEW_STATE_KEY_PREFIX)) continue;
    const stored = readStoredQuietly(store, key);
    entries.push({ key, savedAt: stored });
  }
  return entries.sort((a, b) => a.savedAt - b.savedAt).map((entry) => entry.key);
}

function readStoredQuietly(store: Storage, key: string): number {
  try {
    const raw = store.getItem(key);
    const stored = raw === null ? null : parseEnvelope(raw);
    return stored?.kind === "ok" || stored?.kind === "future" ? stored.savedAt : 0;
  } catch {
    return 0;
  }
}

function removeQuietly(store: Storage, key: string): boolean {
  try {
    store.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

/** Drop the oldest bags until at most `limit` remain, never `keep`. */
function pruneTo(store: Storage, limit: number, keep: string): void {
  const keys = keysOldestFirst(store).filter((key) => key !== keep);
  let excess = keys.length + 1 - limit;
  for (const key of keys) {
    if (excess <= 0) break;
    if (removeQuietly(store, key)) excess--;
  }
}

/**
 * Write `value`, making room when the origin's quota refuses it: each refusal
 * drops the oldest other bag and tries again, until there is nothing left to
 * drop. Never drops anything that is not a plugin view's bag.
 */
function writeWithRoom(store: Storage, key: string, value: string): boolean {
  for (;;) {
    try {
      store.setItem(key, value);
      return true;
    } catch {
      const oldest = keysOldestFirst(store).find((candidate) => candidate !== key);
      if (oldest === undefined || !removeQuietly(store, oldest)) return false;
    }
  }
}

/**
 * The view's stored bag, decoded against what the plugin declares now. `null`
 * when nothing is stored (or storage is unavailable). A bag a newer build of
 * the plugin wrote comes back `ok: false` and stays on disk untouched.
 */
export function readPluginViewState(
  identity: PluginViewStateIdentity,
  declaredVersion: number | undefined
): PanelExtensionStateDecode | null {
  const store = storage();
  if (!store) return null;
  const stored = readStored(store, pluginViewStateKey(identity));
  if (stored.kind !== "ok") return null;
  return decodePanelExtensionState({
    state: stored.envelope.state,
    persistedVersion: stored.envelope.version,
    declaredVersion,
  });
}

/**
 * Merge `patch` into the view's bag and write it through. `false` when the
 * patch is refused (not JSON, over the cap), when the stored bag belongs to a
 * newer build of the plugin or the app and must not be overwritten, or when
 * storage would not take the write even after making room.
 */
export function persistPluginViewState(
  identity: PluginViewStateIdentity,
  patch: Record<string, unknown>,
  declaredVersion: number | undefined
): boolean {
  const store = storage();
  if (!store) return false;
  const key = pluginViewStateKey(identity);
  const stored = readStored(store, key);
  if (stored.kind === "future") return false;
  const current = stored.kind === "ok" ? stored.envelope : undefined;
  if (
    current?.version !== undefined &&
    declaredVersion !== undefined &&
    current.version > declaredVersion
  ) {
    return false;
  }

  let result;
  try {
    result = applyExtensionStatePatch(current?.state, patch, {
      current: current?.version,
      next: declaredVersion,
    });
  } catch {
    return false;
  }
  if (!result.ok) {
    logWarn("[plugin-view-state] Rejected a view state update", {
      pluginId: identity.pluginId,
      host: identity.host,
      reason: result.reason,
    });
    return false;
  }
  const { commit } = result;
  if (commit.kind === "unchanged") return true;

  const envelope: Envelope = {
    schema: ENVELOPE_SCHEMA,
    savedAt: Date.now(),
    state: commit.kind === "replace" ? commit.state : (current?.state ?? {}),
    ...(commit.version !== undefined ? { version: commit.version } : {}),
  };
  if (!writeWithRoom(store, key, JSON.stringify(envelope))) {
    logWarn("[plugin-view-state] Storage refused a view state update", {
      pluginId: identity.pluginId,
      host: identity.host,
    });
    return false;
  }
  if (!current) pruneTo(store, MAX_PLUGIN_VIEW_STATE_ENTRIES, key);
  return true;
}
