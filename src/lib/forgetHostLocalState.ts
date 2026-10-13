import { parseHostScopedKey, type HostId } from "@shared/types/remoteHosts";
import type { RemoteHostsEvent } from "@shared/types/ipc/remoteHosts";
import { QUICK_RUN_KEY_PREFIXES } from "@/components/Project/quickRunStorageKeys";
import { useCommandHistoryStore } from "@/store/commandHistoryStore";
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

/**
 * Drop what this view's renderer keeps under a removed host's id: prompt and
 * URL history, split layouts and QuickRun's toggles, all keyed
 * `<hostId>:<id>`. Each store goes through its own state, so its write records
 * the removal rather than a sibling view's next write bringing it back.
 */
export function forgetHostLocalState(hostId: HostId): void {
  const history = withoutHost(useCommandHistoryStore.getState().history, hostId);
  if (history) useCommandHistoryStore.setState({ history });
  const entries = withoutHost(useUrlHistoryStore.getState().entries, hostId);
  if (entries) useUrlHistoryStore.setState({ entries });
  const ratios = withoutHost(useTwoPaneSplitStore.getState().ratioByWorktreeId, hostId);
  if (ratios) useTwoPaneSplitStore.setState({ ratioByWorktreeId: ratios });

  try {
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
    logWarn("Clearing a removed host's QuickRun state failed", { error });
  }
}

/** Every view clears a host's state here when the host is removed from this device. */
export function installForgetHostLocalState(): () => void {
  return window.electron.remoteHosts.onEvent((event: RemoteHostsEvent) => {
    if (event.type === "host-forgotten") forgetHostLocalState(event.hostId);
  });
}
