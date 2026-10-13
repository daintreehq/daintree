import { parseHostScopedKey, type HostId } from "@shared/types/remoteHosts";
import type { RemoteHostsEvent } from "@shared/types/ipc/remoteHosts";
import { forgetBuildMismatchNotices } from "@/components/Hosts/buildMismatchNotice";
import { QUICK_RUN_KEY_PREFIXES } from "@/components/Project/quickRunStorageKeys";
import { useCommandHistoryStore } from "@/store/commandHistoryStore";
import { backupKeyFor } from "@/store/persistence/safeStorage";
import { useTwoPaneSplitStore } from "@/store/twoPaneSplitStore";
import { useUrlHistoryStore } from "@/store/urlHistoryStore";
import { logWarn } from "@/utils/logger";

function withoutHost<V>(record: Record<string, V>, hostId: HostId): Record<string, V> | null {
  const kept: Record<string, V> = {};
  let dropped = false;
  for (const [key, value] of Object.entries(record)) {
    if (parseHostScopedKey(key).hostId === hostId) dropped = true;
    else kept[key] = value;
  }
  return dropped ? kept : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Remove the host's entries from one persisted blob as stored. A view only
 * deletes keys it read when it hydrated, so entries another view wrote since
 * (often the host's own view, already gone) are taken out on disk here.
 */
function scrubStoredRecord(storageKey: string, field: string, hostId: HostId): void {
  const raw = localStorage.getItem(storageKey);
  if (raw === null) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  if (!isRecord(parsed) || !isRecord(parsed.state)) return;
  const record = parsed.state[field];
  if (!isRecord(record)) return;
  const kept = withoutHost(record, hostId);
  if (!kept) return;
  localStorage.setItem(
    storageKey,
    JSON.stringify({ ...parsed, state: { ...parsed.state, [field]: kept } })
  );
}

const HOST_KEYED_STORES = [
  { store: useCommandHistoryStore, field: "history" },
  { store: useUrlHistoryStore, field: "entries" },
  { store: useTwoPaneSplitStore, field: "ratioByWorktreeId" },
] as const;

/**
 * Drop what this view's renderer keeps under a removed host's id: prompt and
 * URL history, split layouts, QuickRun's toggles and build notices, all keyed
 * by the host's id. Stored copies are scrubbed first, then each store's own
 * state, so its next write records the removal rather than bringing it back.
 */
export function forgetHostLocalState(hostId: HostId): void {
  try {
    for (const { store, field } of HOST_KEYED_STORES) {
      const name = store.persist.getOptions().name;
      if (!name) continue;
      scrubStoredRecord(name, field, hostId);
      scrubStoredRecord(backupKeyFor(name), field, hostId);
    }
    const doomed: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      const prefix = key && QUICK_RUN_KEY_PREFIXES.find((p) => key.startsWith(p));
      if (key && prefix && parseHostScopedKey(key.slice(prefix.length)).hostId === hostId) {
        doomed.push(key);
      }
    }
    for (const key of doomed) localStorage.removeItem(key);
  } catch (error) {
    logWarn("Clearing a removed host's stored state failed", { error });
  }

  const history = withoutHost(useCommandHistoryStore.getState().history, hostId);
  if (history) useCommandHistoryStore.setState({ history });
  const entries = withoutHost(useUrlHistoryStore.getState().entries, hostId);
  if (entries) useUrlHistoryStore.setState({ entries });
  const ratios = withoutHost(useTwoPaneSplitStore.getState().ratioByWorktreeId, hostId);
  if (ratios) useTwoPaneSplitStore.setState({ ratioByWorktreeId: ratios });
  forgetBuildMismatchNotices(hostId);
}

/** Every view clears a host's state here when the host is removed from this device. */
export function installForgetHostLocalState(): () => void {
  return window.electron.remoteHosts.onEvent((event: RemoteHostsEvent) => {
    if (event.type === "host-forgotten") forgetHostLocalState(event.hostId);
  });
}
