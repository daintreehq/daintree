import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { z } from "zod";
import { useDiagnosticsStore } from "@/store/diagnosticsStore";
import { useErrorStore } from "@/store/errorStore";
import { usePortalStore } from "@/store/portalStore";
import { usePanelStore, type TerminalInstance } from "@/store/panelStore";

export function registerPanelCoreActions(
  actions: ActionRegistry,
  callbacks: ActionCallbacks
): void {
  actions.set("panel.list", () => ({
    id: "panel.list",
    title: "List Panels",
    description: "Get list of all panels with layout information",
    category: "panel",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    argsSchema: z
      .object({
        worktreeId: z.string().optional(),
        location: z.enum(["grid", "dock", "trash", "background"]).optional(),
      })
      .optional(),
    resultSchema: z.object({
      panels: z.array(
        z.object({
          id: z.string(),
          kind: z.string(),
          type: z.unknown().nullable(),
          worktreeId: z.string().nullable(),
          title: z.string().nullable(),
          location: z.string(),
          agentId: z.string().nullable(),
          agentState: z.string().nullable(),
        })
      ),
      dock: z.object({ panelCount: z.number() }),
      portal: z.object({
        isOpen: z.boolean(),
        tabCount: z.number(),
        activeTabId: z.string().nullable(),
      }),
      focusedPanelId: z.string().nullable(),
      maximizedPanelId: z.string().nullable(),
    }),
    run: async (args: unknown) => {
      const { worktreeId, location } = (args ?? {}) as {
        worktreeId?: string;
        location?: "grid" | "dock" | "trash" | "background";
      };
      const state = usePanelStore.getState();
      let panels = state.panelIds
        .map((id) => state.panelsById[id])
        .filter((p): p is TerminalInstance => p !== undefined);

      if (worktreeId) {
        panels = panels.filter((p) => p.worktreeId === worktreeId);
      }

      if (location) {
        panels = panels.filter((p) => p.location === location);
      } else {
        panels = panels.filter((p) => p.location !== "trash" && p.location !== "background");
      }

      const portalState = usePortalStore.getState();

      return {
        panels: panels.map((p) => ({
          id: p.id,
          kind: p.kind,
          type: undefined,
          worktreeId: p.worktreeId ?? null,
          title: p.title ?? null,
          location: p.location ?? "grid",
          agentId: p.launchAgentId ?? null,
          agentState: p.agentState ?? null,
        })),
        dock: {
          panelCount: panels.filter((p) => p.location === "dock").length,
        },
        portal: {
          isOpen: portalState.isOpen,
          tabCount: portalState.tabs.length,
          activeTabId: portalState.activeTabId,
        },
        focusedPanelId: state.focusedId ?? null,
        maximizedPanelId: state.maximizedId ?? null,
      };
    },
  }));

  actions.set("panel.focus", () => ({
    id: "panel.focus",
    title: "Focus Panel",
    description: "Focus a specific panel by ID",
    category: "panel",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({
      panelId: z.string(),
    }),
    run: async (args: unknown) => {
      const { panelId } = args as { panelId: string };
      const terminalState = usePanelStore.getState();
      const found = terminalState.panelsById[panelId];
      const panel = found && found.location !== "trash" ? found : undefined;
      if (!panel) {
        throw new Error("Terminal panel no longer exists");
      }
      terminalState.activateTerminal(panelId);
    },
  }));

  actions.set("panel.palette", () => ({
    id: "panel.palette",
    title: "Panel Palette",
    description: "Open panel palette to create non-PTY panels",
    category: "panel",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["create", "add", "launcher", "picker"],
    nonRepeatable: true,
    run: async () => {
      callbacks.onOpenPanelPalette();
    },
  }));

  actions.set("panel.toggleDiagnostics", () => ({
    id: "panel.toggleDiagnostics",
    title: "Toggle Diagnostics",
    description: "Toggle the diagnostics panel",
    category: "panel",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["debug", "problems", "lint", "events"],
    run: async () => {
      useDiagnosticsStore.getState().toggleDock();
    },
  }));

  actions.set("panel.diagnosticsLogs", () => ({
    id: "panel.diagnosticsLogs",
    title: "Show Logs",
    description: "Open diagnostics panel with logs tab",
    category: "panel",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["debug", "output", "trace", "console"],
    run: async () => {
      useDiagnosticsStore.getState().openDock("logs");
    },
  }));

  actions.set("panel.diagnosticsEvents", () => ({
    id: "panel.diagnosticsEvents",
    title: "Show Events",
    description: "Open diagnostics panel with events tab",
    category: "panel",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["debug", "timeline", "activity", "trace"],
    run: async () => {
      useDiagnosticsStore.getState().openDock("events");
    },
  }));

  actions.set("panel.diagnosticsMessages", () => ({
    id: "panel.diagnosticsMessages",
    title: "Show Problems",
    description: "Open diagnostics panel with problems tab",
    category: "panel",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["errors", "warnings", "issues", "lint"],
    run: async () => {
      useDiagnosticsStore.getState().openDock("problems");
      useErrorStore.getState().promoteErrors();
    },
  }));

  actions.set("panel.togglePortal", () => ({
    id: "panel.togglePortal",
    title: "Toggle Portal",
    description: "Toggle the portal panel",
    category: "panel",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["web", "embed", "browser", "dock"],
    run: async () => {
      window.dispatchEvent(new CustomEvent("daintree:toggle-portal"));
    },
  }));
}
