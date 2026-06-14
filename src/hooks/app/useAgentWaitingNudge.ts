import { useEffect, useRef } from "react";
import { usePanelStore } from "@/store/panelStore";
import { isPtyPanel } from "@shared/types/panel";
import { useNotificationStore } from "@/store/notificationStore";
import { useNotificationSettingsStore } from "@/store/notificationSettingsStore";
import { getOnboardingState } from "@/clients/onboardingClient";
import { notify } from "@/lib/notify";
import { isElectronAvailable } from "../useElectron";
import { safeFireAndForget } from "@/utils/safeFireAndForget";

/**
 * Resolves once the notification-settings store has hydrated. App kicks
 * `hydrate()` at mount, so by the time `isStateLoaded` flips this is normally
 * already settled and the wait is a microtask.
 */
function waitForNotificationSettingsHydrated(): Promise<void> {
  if (useNotificationSettingsStore.getState().hydrated) return Promise.resolve();
  return new Promise((resolve) => {
    const unsubscribe = useNotificationSettingsStore.subscribe((state) => {
      if (state.hydrated) {
        unsubscribe();
        resolve();
      }
    });
  });
}

export function useAgentWaitingNudge(isStateLoaded: boolean): void {
  const removeNotification = useNotificationStore((s) => s.removeNotification);
  const eligibleRef = useRef(false);
  const firedRef = useRef(false);
  const notificationIdRef = useRef<string | null>(null);

  function fireNudge(panelId: string) {
    if (firedRef.current) return;
    firedRef.current = true;

    safeFireAndForget(window.electron.onboarding.markWaitingNudgeSeen(), {
      context: "Marking agent waiting nudge seen",
    });

    const id = notify({
      type: "info",
      placement: "grid-bar",
      title: "Agent waiting for input",
      message:
        "Your agent is waiting for input. Enable notifications to get alerted when this happens.",
      inboxMessage:
        "Your agent is waiting for input. Enable notifications to get alerted when this happens.",
      duration: 0,
      context: { eventKind: "waiting", panelId },
      actions: [
        {
          label: "Enable notifications",
          variant: "primary",
          onClick: () => {
            safeFireAndForget(
              window.electron.notification.setSettings({
                waitingEnabled: true,
              }),
              { context: "Enabling waiting agent notifications" }
            );
            if (notificationIdRef.current) {
              removeNotification(notificationIdRef.current);
              notificationIdRef.current = null;
            }
          },
        },
        {
          label: "No thanks",
          variant: "secondary",
          onClick: () => {
            if (notificationIdRef.current) {
              removeNotification(notificationIdRef.current);
              notificationIdRef.current = null;
            }
          },
        },
      ],
    });

    notificationIdRef.current = id || null;
  }

  useEffect(() => {
    if (!isElectronAvailable() || !isStateLoaded) return;

    let cancelled = false;

    async function hydrate() {
      try {
        // Shared same-tick onboarding fetch (deduped with the checklist
        // hook's effect in the same flush); `waitingEnabled` comes from the
        // settings store hydrated at App mount instead of a duplicate
        // `notification:getSettings` round-trip.
        const onboarding = await getOnboardingState();
        if (cancelled) return;
        if (!onboarding.completed || onboarding.waitingNudgeSeen) return;

        await waitForNotificationSettingsHydrated();
        if (cancelled) return;
        if (useNotificationSettingsStore.getState().waitingEnabled) return;

        eligibleRef.current = true;

        const { panelsById, panelIds } = usePanelStore.getState();
        const waitingId = panelIds.find((id) => {
          const p = panelsById[id];
          return p && isPtyPanel(p) && p.agentState === "waiting";
        });
        if (waitingId && !firedRef.current) {
          fireNudge(waitingId);
        }
      } catch {
        // Silently ignore — nudge is non-critical
      }
    }

    safeFireAndForget(hydrate(), { context: "Hydrating agent waiting nudge state" });
    return () => {
      cancelled = true;
    };
  }, [isStateLoaded]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!isElectronAvailable() || !isStateLoaded) return;

    const initState = usePanelStore.getState();
    let prevAgentStates = new Map<string, string | undefined>(
      initState.panelIds.map((id) => {
        const p = initState.panelsById[id];
        return [id, p && isPtyPanel(p) ? p.agentState : undefined];
      })
    );

    const unsubscribe = usePanelStore.subscribe((state) => {
      if (!eligibleRef.current || firedRef.current) return;

      const currentAgentStates = new Map<string, string | undefined>(
        state.panelIds.map((id) => {
          const p = state.panelsById[id];
          return [id, p && isPtyPanel(p) ? p.agentState : undefined];
        })
      );

      for (const id of state.panelIds) {
        const terminal = state.panelsById[id];
        if (!terminal || !isPtyPanel(terminal)) continue;
        const prev = prevAgentStates.get(id);
        if (terminal.agentState === "waiting" && prev !== "waiting") {
          fireNudge(id);
          break;
        }
      }

      prevAgentStates = currentAgentStates;
    });

    return unsubscribe;
  }, [isStateLoaded]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    return () => {
      if (notificationIdRef.current) {
        removeNotification(notificationIdRef.current);
      }
    };
  }, [removeNotification]);
}
