import type { AgentDefaultsSnapshot } from "@shared/types";
import { isAgentInstalled } from "@shared/utils/agentAvailability";
import { agentDefaultsClient } from "@/clients/agentDefaultsClient";
import { getSafeBootPromise } from "@/lib/bootPromise";
import { isRemoteWindow } from "@/hooks/useHostPlatform";
import { logWarn } from "@/utils/logger";
import { onHostResync, readSettingOnResync, type HostResync } from "@/store/hostResyncSignal";
import { useAgentPreferencesStore } from "@/store/agentPreferencesStore";
import { useCliAvailabilityStore } from "@/store/cliAvailabilityStore";
import { useHelpPanelStore, type AssistantAgentAvailability } from "@/store/helpPanelStore";
import {
  clearLegacyAgentDefaults,
  hasLegacyAgentDefaults,
  readLegacyAgentDefaults,
} from "@/store/persistence/agentDefaultsLegacy";

function currentAvailability(): AssistantAgentAvailability {
  const { availability, hasRealData, lastCheckedAt } = useCliAvailabilityStore.getState();
  return {
    // The startup cache is one blob shared by every window on this machine,
    // whichever host it came from, so only a live probe in this view counts as
    // evidence that the host lacks a CLI.
    hasRealData: hasRealData && lastCheckedAt !== null,
    isInstalled: (agentId) => isAgentInstalled(availability[agentId]),
  };
}

function applySnapshot(snapshot: AgentDefaultsSnapshot): void {
  useAgentPreferencesStore.getState().applyHostDefaultAgent(snapshot.defaultAgent);
  useHelpPanelStore
    .getState()
    .syncHostAssistantAgent(snapshot.assistantAgentId ?? null, currentAvailability());
}

/**
 * Keeps this view's mirrors of the host's agent defaults current (#13345):
 * seeded from the boot payload, updated by the host's pushes and refetched
 * after a dropped link, and — in a local window only — fed this machine's
 * pre-#13345 localStorage values once, for the host to take or ignore. A
 * remote window never sends them: its localStorage is this Shell's, not the
 * host's.
 */
export function initAgentDefaultsSync(): () => void {
  if (typeof window === "undefined" || !window.electron?.agentDefaults) return () => {};

  let disposed = false;
  // Bumped by every push. A reply to a request that started before the latest
  // push is older than that push and is dropped.
  let pushSeq = 0;
  // The newest snapshot this view took as the host's word. Cleanup follows it,
  // not a reply a later push already overtook.
  let accepted: AgentDefaultsSnapshot | undefined;
  const remote = isRemoteWindow();
  // Read before anything else in this view can write, so a store that
  // rewrites its own blob on boot can't drop a value before it's sent.
  const candidates = remote ? {} : readLegacyAgentDefaults();

  const accept = (snapshot: AgentDefaultsSnapshot) => {
    accepted = snapshot;
    applySnapshot(snapshot);
  };

  const applyIfCurrent = (snapshot: AgentDefaultsSnapshot | undefined, startedAt: number) => {
    if (disposed || !snapshot || pushSeq !== startedAt) return;
    accept(snapshot);
  };

  const unsubscribePush = agentDefaultsClient.onChanged((snapshot) => {
    if (disposed) return;
    pushSeq += 1;
    accept(snapshot);
  });

  // Availability decides whether the host's choice is usable here, so it
  // re-resolves against the mirror's own value: an in-flight pick in this view
  // must not be reverted to an older snapshot.
  const unsubscribeAvailability = useCliAvailabilityStore.subscribe((state, prev) => {
    if (
      state.availability === prev.availability &&
      state.hasRealData === prev.hasRealData &&
      state.lastCheckedAt === prev.lastCheckedAt
    ) {
      return;
    }
    useHelpPanelStore.getState().refreshAssistantAvailability(currentAvailability());
  });

  const refetch = async (
    startedAt: number,
    resync: HostResync = {}
  ): Promise<AgentDefaultsSnapshot | undefined> => {
    try {
      const snapshot = await readSettingOnResync(
        resync,
        (settings) => settings.agentDefaults,
        () => agentDefaultsClient.get()
      );
      applyIfCurrent(snapshot, startedAt);
      return snapshot;
    } catch (error) {
      // An older host has no such channel; it has no defaults to mirror.
      logWarn("[agentDefaults] couldn't read the host's agent defaults", {
        error: String(error),
      });
      return undefined;
    }
  };

  const unsubscribeResync = onHostResync((resync) => {
    if (!disposed) void refetch(pushSeq, resync);
  });

  void (async () => {
    const startedAt = pushSeq;
    const boot = await getSafeBootPromise();
    let settled: AgentDefaultsSnapshot | undefined = boot.ok
      ? boot.result.agentDefaults
      : undefined;
    if (settled) applyIfCurrent(settled, startedAt);
    else if (!disposed) settled = await refetch(startedAt);
    if (disposed || remote || !settled) return;

    try {
      if (hasLegacyAgentDefaults(candidates)) {
        const migrationStartedAt = pushSeq;
        applyIfCurrent(await agentDefaultsClient.migrateLegacy(candidates), migrationStartedAt);
      }
      if (!disposed && accepted) clearLegacyAgentDefaults(accepted);
    } catch (error) {
      // The legacy values stay put, so the next local boot tries again.
      logWarn("[agentDefaults] couldn't move this machine's agent defaults to the host", {
        error: String(error),
      });
    }
  })();

  return () => {
    disposed = true;
    unsubscribePush();
    unsubscribeAvailability();
    unsubscribeResync();
  };
}
