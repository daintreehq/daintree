import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { z } from "zod";
import { errorsClient, eventInspectorClient, logsClient } from "@/clients";
import { useErrorStore } from "@/store/errorStore";
import { useEventStore } from "@/store/eventStore";
import { useLogsStore } from "@/store/logsStore";

export function registerLogActions(actions: ActionRegistry, _callbacks: ActionCallbacks): void {
  actions.set("logs.openFile", () => ({
    id: "logs.openFile",
    title: "Open Logs File",
    description: "Open the logs file in the system file manager",
    category: "logs",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      await logsClient.openFile();
    },
  }));

  actions.set("logs.getAll", () => ({
    id: "logs.getAll",
    title: "Get Logs",
    description: "Get buffered application logs",
    category: "logs",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ filters: z.any().optional() }).optional(),
    run: async (args: unknown) => {
      const { filters } = (args as { filters?: unknown } | undefined) ?? {};
      return await logsClient.getAll(filters as any);
    },
  }));

  actions.set("logs.getSources", () => ({
    id: "logs.getSources",
    title: "Get Log Sources",
    description: "Get distinct log sources",
    category: "logs",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      return await logsClient.getSources();
    },
  }));

  actions.set("logs.clear", () => ({
    id: "logs.clear",
    title: "Clear Logs",
    description: "Clear application logs",
    category: "logs",
    kind: "command",
    danger: "confirm",
    scope: "renderer",
    run: async () => {
      useLogsStore.getState().clearLogs();
      await logsClient.clear();
    },
  }));

  actions.set("logs.setVerbose", () => ({
    id: "logs.setVerbose",
    title: "Set Verbose Logging",
    description: "Enable or disable verbose logging",
    category: "logs",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ enabled: z.boolean() }),
    resultSchema: z.object({ success: z.boolean() }),
    run: async (args: unknown) => {
      const { enabled } = args as { enabled: boolean };
      return await logsClient.setVerbose(enabled);
    },
  }));

  actions.set("logs.getVerbose", () => ({
    id: "logs.getVerbose",
    title: "Get Verbose Logging",
    description: "Get whether verbose logging is enabled",
    category: "logs",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      return await logsClient.getVerbose();
    },
  }));

  actions.set("errors.openLogs", () => ({
    id: "errors.openLogs",
    title: "Open Error Logs",
    description: "Open the error log file",
    category: "errors",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      await errorsClient.openLogs();
    },
  }));

  actions.set("errors.clearAll", () => ({
    id: "errors.clearAll",
    title: "Clear All Errors",
    description: "Clear all error banners and problem entries",
    category: "errors",
    kind: "command",
    danger: "confirm",
    scope: "renderer",
    run: async () => {
      useErrorStore.getState().clearAll();
    },
  }));

  actions.set("eventInspector.getEvents", () => ({
    id: "eventInspector.getEvents",
    title: "Get Events",
    description: "Get captured events from the event inspector",
    category: "diagnostics",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      return await eventInspectorClient.getEvents();
    },
  }));

  actions.set("eventInspector.getFiltered", () => ({
    id: "eventInspector.getFiltered",
    title: "Get Filtered Events",
    description: "Get filtered events from the event inspector",
    category: "diagnostics",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ filters: z.any() }),
    run: async (args: unknown) => {
      const { filters } = args as { filters: unknown };
      return await eventInspectorClient.getFiltered(filters as any);
    },
  }));

  actions.set("eventInspector.subscribe", () => ({
    id: "eventInspector.subscribe",
    title: "Subscribe to Events",
    description: "Start streaming events into the event inspector",
    category: "diagnostics",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      eventInspectorClient.subscribe();
    },
  }));

  actions.set("eventInspector.unsubscribe", () => ({
    id: "eventInspector.unsubscribe",
    title: "Unsubscribe from Events",
    description: "Stop streaming events into the event inspector",
    category: "diagnostics",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      eventInspectorClient.unsubscribe();
    },
  }));

  actions.set("eventInspector.clear", () => ({
    id: "eventInspector.clear",
    title: "Clear Event Inspector",
    description: "Clear captured events in the event inspector",
    category: "diagnostics",
    kind: "command",
    danger: "confirm",
    scope: "renderer",
    run: async () => {
      useEventStore.getState().clearEvents();
      await eventInspectorClient.clear();
    },
  }));

  actions.set("ui.refresh", () => ({
    id: "ui.refresh",
    title: "Reload Application",
    description: "Reload the renderer (useful for recovery)",
    category: "ui",
    kind: "command",
    danger: "confirm",
    scope: "renderer",
    run: async () => {
      window.location.reload();
    },
  }));

  actions.set("ui.sidebar.resetWidth", () => ({
    id: "ui.sidebar.resetWidth",
    title: "Reset Sidebar Width",
    description: "Reset the sidebar width to default",
    category: "ui",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      window.dispatchEvent(new CustomEvent("canopy:reset-sidebar-width"));
    },
  }));
}
