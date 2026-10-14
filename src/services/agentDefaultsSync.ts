import type { AgentDefaultsSnapshot } from "@shared/types";
import { isAgentInstalled } from "@shared/utils/agentAvailability";
import { agentDefaultsClient } from "@/clients/agentDefaultsClient";
import { getSafeBootPromise } from "@/lib/bootPromise";
import { isRemoteWindow } from "@/hooks/useHostPlatform";
import { logWarn } from "@/utils/logger";
import { useAgentPreferencesStore } from "@/store/agentPreferencesStore";
import { useCliAvailabilityStore } from "@/store/cliAvailabilityStore";
import { useHelpPanelStore, type AssistantAgentAvailability } from "@/store/helpPanelStore";
import {
  clearLegacyAgentDefaults,
  hasLegacyAgentDefaults,
  readLegacyAgentDefaults,
} from "@/store/persistence/agentDefaultsLegacy";

function currentAvailability(): AssistantAgentAvailability {
  const { availability, hasRealData } = useCliAvailabilityStore.getState();
  return { hasRealData, isInstalled: (agentId) => isAgentInstalled(availability[agentId]) };
}

function applySnapshot(snapshot: AgentDefaultsSnapshot): void {
  useAgentPreferencesStore.getState().applyHostDefaultAgent(snapshot.defaultAgent);
  useHelpPanelStore
    .getState()
    .syncHostAssistantAgent(snapshot.assistantAgentId ?? null, currentAvailability());
}

/**
 * Keeps this view's mirrors of the host's agent defaults current (#13345):
 * seeded from the boot payload, updated by the host's pushes, and — in a
 * local window only — fed this machine's pre-#13345 localStorage values once,
 * for the host to take or ignore. A remote window never sends them: its
 * localStorage is this Shell's, not the host's.
 */
export function initAgentDefaultsSync(): () => void {
  if (typeof window === "undefined" || !window.electron?.agentDefaults) return () => {};

  let disposed = false;
  let pushed = false;

  const unsubscribePush = agentDefaultsClient.onChanged((snapshot) => {
    if (disposed) return;
    pushed = true;
    applySnapshot(snapshot);
  });

  // Availability decides whether the host's choice is usable here, so it
  // re-resolves against the mirror's own value: an in-flight pick in this view
  // must not be reverted to an older snapshot.
  const unsubscribeAvailability = useCliAvailabilityStore.subscribe((state, prev) => {
    if (state.availability === prev.availability && state.hasRealData === prev.hasRealData) return;
    const help = useHelpPanelStore.getState();
    help.syncHostAssistantAgent(help.hostAssistantAgentId, currentAvailability());
  });

  void (async () => {
    const boot = await getSafeBootPromise();
    let initial: AgentDefaultsSnapshot | undefined = boot.ok
      ? boot.result.agentDefaults
      : undefined;
    if (!initial && !disposed && !pushed) {
      try {
        initial = await agentDefaultsClient.get();
      } catch (error) {
        // An older host has no such channel; it has no defaults to mirror.
        logWarn("[agentDefaults] couldn't read the host's agent defaults", {
          error: String(error),
        });
      }
    }
    if (disposed) return;
    // A push is newer than any boot snapshot that was in flight beside it.
    if (initial && !pushed) applySnapshot(initial);

    if (isRemoteWindow()) return;
    const candidates = readLegacyAgentDefaults();
    try {
      if (hasLegacyAgentDefaults(candidates)) {
        const result = await agentDefaultsClient.migrateLegacy(candidates);
        if (!disposed) applySnapshot(result);
      }
      clearLegacyAgentDefaults();
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
  };
}
