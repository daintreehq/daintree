import type { ActionRegistry } from "../actionTypes";
import { watchdogClient } from "@/clients/watchdogClient";
import { usePanelStore } from "@/store/panelStore";

export function registerWatchdogActions(actions: ActionRegistry): void {
  actions.set("watchdog.restart", () => ({
    id: "watchdog.restart",
    title: "Restart crash watchdog",
    description:
      "Restart the main-process deadlock detector after it has been disabled by repeated crashes. Available only when the watchdog is in the disabled state surfaced by the recovery banner.",
    category: "system",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["deadlock", "watchdog", "recover", "main-process", "hang"],
    isEnabled: () => usePanelStore.getState().watchdogStatus === "disabled",
    disabledReason: () => {
      if (usePanelStore.getState().watchdogStatus !== "disabled") {
        return "Crash watchdog is active";
      }
      return undefined;
    },
    run: async () => {
      await watchdogClient.restart();
      usePanelStore.getState().clearWatchdogDisabled();
    },
  }));
}
