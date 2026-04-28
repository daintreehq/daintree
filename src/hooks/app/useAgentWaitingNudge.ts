import { useEffect, useRef } from "react";
import { usePanelStore } from "@/store/panelStore";
import { useNotificationStore } from "@/store/notificationStore";
import { notify } from "@/lib/notify";
import { isElectronAvailable } from "../useElectron";
import { safeFireAndForget } from "@/utils/safeFireAndForget";

export function useAgentWaitingNudge(isStateLoaded: boolean): void {
  const removeNotification = useNotificationStore((s) => s.removeNotification);
  const eligibleRef = useRef(false);
  const firedRef = useRef(false);
  const notificationIdRef = useRef<string | null>(null);

  function fireNudge() {
    if (firedRef.current) return;
    firedRef.current = true;

    safeFireAndForget(window.electron.onboarding.markWaitingNudgeSeen(), {
      context: "Marking agent waiting nudge seen",
    });

    const id = notify({
      type: "info",
      placement: "grid-bar",
      title: "Agent Waiting for Input",
      message:
        "Your agent is waiting for input. Enable notifications to get alerted when this happens.",
      inboxMessage:
        "Your agent is waiting for input. Enable notifications to get alerted when this happens.",
      duration: 0,
      actions: [
        {
          label: "Enable Notifications",
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
          label: "No Thanks",
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
        const [onboarding, notifSettings] = await Promise.all([
          window.electron.onboarding.get(),
          window.electron.notification.getSettings(),
        ]);

        if (cancelled) return;

        if (!onboarding.completed || onboarding.waitingNudgeSeen || notifSettings.waitingEnabled) {
          return;
        }

        eligibleRef.current = true;

        const { panelsById, panelIds } = usePanelStore.getState();
        const hasWaiting = panelIds.some((id) => panelsById[id]?.agentState === "waiting");
        if (hasWaiting && !firedRef.current) {
          fireNudge();
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
      initState.panelIds.map((id) => [id, initState.panelsById[id]?.agentState])
    );

    const unsubscribe = usePanelStore.subscribe((state) => {
      if (!eligibleRef.current || firedRef.current) return;

      const currentAgentStates = new Map<string, string | undefined>(
        state.panelIds.map((id) => [id, state.panelsById[id]?.agentState])
      );

      for (const id of state.panelIds) {
        const terminal = state.panelsById[id];
        if (!terminal) continue;
        const prev = prevAgentStates.get(id);
        if (terminal.agentState === "waiting" && prev !== "waiting") {
          fireNudge();
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
