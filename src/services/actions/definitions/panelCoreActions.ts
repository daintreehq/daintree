import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { z } from "zod";
import { useDiagnosticsStore } from "@/store/diagnosticsStore";
import { useErrorStore } from "@/store/errorStore";
import { usePortalStore } from "@/store/portalStore";
import { usePanelStore } from "@/store/panelStore";
import { isPtyPanel, type PanelInstance } from "@shared/types/panel";
import { getPanelKindConfig } from "@shared/config/panelKindRegistry";

const openPluginPanelArgsSchema = z.object({
  kind: z.string().min(1),
  initialArgs: z.record(z.string(), z.unknown()).optional(),
  worktreeId: z.string().optional(),
  reuseExisting: z.boolean().optional(),
});

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
          // `.optional()` is load-bearing: zod 4 strips `z.unknown()`'s implicit
          // optionality once it's wrapped in `.nullable()`, so without it a
          // MISSING key fails where an explicit `undefined` passes. Same fix as
          // the sibling TerminalSummarySchema in schemas.ts.
          type: z.unknown().nullable().optional(),
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
        .filter((p): p is PanelInstance => p !== undefined);

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
          agentId: isPtyPanel(p) ? (p.launchAgentId ?? null) : null,
          agentState: isPtyPanel(p) ? (p.agentState ?? null) : null,
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

  actions.set("panel.openPluginPanel", () => ({
    id: "panel.openPluginPanel",
    title: "Open Plugin Panel",
    description:
      "Spawn (or focus an existing) plugin-contributed panel kind, handing it an initial argument. Args: `kind` (required) — the plugin panel kind id from `contributes.panels`; `initialArgs` (optional) — an opaque bag delivered to the view as `PanelViewProps.initialArgs` (e.g. `{ path }` to open a file); `worktreeId` (optional) — target worktree, which must belong to the current project; `reuseExisting` (optional, default true) — focus an existing panel of this kind in the worktree instead of spawning a second one. Returns `{ panelId }`. Errors when `kind` is not a registered plugin panel kind, when `worktreeId` belongs to another project, or — transiently, retry — when the project's worktrees haven't loaded yet.",
    category: "panel",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: openPluginPanelArgsSchema,
    run: async (args: unknown) => {
      const { kind, initialArgs, worktreeId, reuseExisting } =
        openPluginPanelArgsSchema.parse(args);
      const kindConfig = getPanelKindConfig(kind);
      // Only plugin-contributed kinds are reachable here — built-in kinds carry
      // no `extensionId` and have their own dedicated spawn actions.
      if (!kindConfig || kindConfig.extensionId === undefined) {
        throw new Error(`"${kind}" is not a registered plugin panel kind`);
      }

      // A supplied worktreeId must belong to the dispatching renderer's own
      // project. This action runs in the invoking project's V8 context, so
      // `getWorktrees()` is already the right scope. Without the check a
      // cross-project id is persisted verbatim onto the panel, which then
      // spawns under a project the user isn't looking at and reads as "the
      // command did nothing" (#11297). Reject rather than silently substituting
      // the active worktree — a silent fallback on a named target is the class
      // of bug #7880 banned. An unloaded worktree list can't establish
      // membership either, so it also rejects, but says so distinctly: that one
      // is transient and worth retrying, a foreign id never will be.
      if (worktreeId !== undefined) {
        const projectWorktrees = callbacks.getWorktrees();
        if (projectWorktrees.length === 0) {
          throw new Error(
            `Can't verify worktree "${worktreeId}": the project's worktrees haven't loaded yet`
          );
        }
        if (!projectWorktrees.some((w) => w.id === worktreeId)) {
          throw new Error(`Worktree "${worktreeId}" does not belong to the current project`);
        }
      }

      const state = usePanelStore.getState();
      const targetWorktreeId = worktreeId ?? callbacks.getActiveWorktreeId();

      if (reuseExisting !== false) {
        const existing = state.panelIds
          .map((id) => state.panelsById[id])
          .find(
            (p): p is PanelInstance =>
              p !== undefined &&
              p.kind === kind &&
              p.location !== "trash" &&
              // Never reuse an ephemeral dialog panel as a grid/dock target —
              // it is uncounted and unpersisted, so adopting it would leak a
              // panel the grid can't account for.
              p.location !== "dialog" &&
              (p.worktreeId ?? undefined) === (targetWorktreeId ?? undefined)
          );
        if (existing) {
          state.activateTerminal(existing.id);
          return { panelId: existing.id };
        }
      }

      const panelId = await state.addPanel(
        // Extension panel kinds are intentionally excluded from the
        // `AddPanelOptions` union (a `kind: string` member would defeat
        // discriminated-union narrowing for built-in kinds — see
        // `shared/types/addPanelOptions.ts`). Widening at this integration
        // boundary is the documented pattern for spawning a custom kind.
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- documented extension-panel spawn boundary
        {
          kind,
          worktreeId: targetWorktreeId,
          location: "grid",
          extensionState: initialArgs,
        } as Parameters<typeof state.addPanel>[0]
      );
      if (!panelId) {
        throw new Error(`Failed to open plugin panel "${kind}"`);
      }
      return { panelId };
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
    // Opens a modal palette — a post-dispatch hint would land on top of it
    // (ShortcutHint sits at z-toast, above z-modal). Issue #11030.
    // Not redundant with dispatch()'s overlay-claim check (#11507): this
    // opener is synchronous, so the continuation can beat the palette's
    // claim effect. Keep the flag.
    suppressShortcutHint: true,
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
