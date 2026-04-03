import { useEffect, useRef } from "react";
import { useTerminalStore } from "@/store/terminalStore";
import { useNotificationStore } from "@/store/notificationStore";
import { notify } from "@/lib/notify";
import { isElectronAvailable } from "../useElectron";

export function useAgentWaitingNudge(isStateLoaded: boolean): void {
  const removeNotification = useNotificationStore((s) => s.removeNotification);
  const eligibleRef = useRef(false);
  const firedRef = useRef(false);
  const notificationIdRef = useRef<string | null>(null);

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

        const { terminalsById, terminalIds } = useTerminalStore.getState();
        const hasWaiting = terminalIds.some((id) => terminalsById[id]?.agentState === "waiting");
        if (hasWaiting && !firedRef.current) {
          fireNudge();
        }
      } catch {
        // Silently ignore — nudge is non-critical
      }
    }

    void hydrate();
    return () => {
      cancelled = true;
    };
  }, [isStateLoaded]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!isElectronAvailable() || !isStateLoaded) return;

    const initState = useTerminalStore.getState();
    let prevAgentStates = new Map<string, string | undefined>(
      initState.terminalIds.map((id) => [id, initState.terminalsById[id]?.agentState])
    );

    const unsubscribe = useTerminalStore.subscribe((state) => {
      if (!eligibleRef.current || firedRef.current) return;

      const currentAgentStates = new Map<string, string | undefined>(
        state.terminalIds.map((id) => [id, state.terminalsById[id]?.agentState])
      );

      for (const id of state.terminalIds) {
        const terminal = state.terminalsById[id];
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

  function fireNudge() {
    if (firedRef.current) return;
    firedRef.current = true;

    void window.electron.onboarding.markWaitingNudgeSeen();

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
            void window.electron.notification.setSettings({
              waitingEnabled: true,
            });
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
}
