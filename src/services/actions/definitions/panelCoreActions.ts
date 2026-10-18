import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { z } from "zod";
import { useDiagnosticsStore } from "@/store/diagnosticsStore";
import { useErrorStore } from "@/store/errorStore";
import { usePortalStore } from "@/store/portalStore";
import { usePanelStore } from "@/store/panelStore";
import { usePanelDialogStore, findPanelDialogsOfKind } from "@/store/panelDialogStore";
import type { DialogSize } from "@/components/ui/AppDialog";
import { focusPanelInput } from "@/components/Panel/panelFocusRegistry";
import { isPtyPanel, type PanelInstance } from "@shared/types/panel";
import { getPanelKindConfig } from "@shared/config/panelKindRegistry";

const PLUGIN_PANEL_DIALOG_SIZES = [
  "sm",
  "md",
  "lg",
  "4xl",
  "5xl",
  "6xl",
  "7xl",
  "workspace",
] as const satisfies readonly DialogSize[];

const openPluginPanelArgsSchema = z.object({
  kind: z.string().min(1),
  initialArgs: z.record(z.string(), z.unknown()).optional(),
  worktreeId: z.string().optional(),
  reuseExisting: z.boolean().optional(),
  presentation: z
    .enum(["panel", "dialog"])
    .optional()
    .describe(
      "Default `panel`. `dialog` presents the view as a modal, replacing any panel dialog already open; when one of this kind is already open for the worktree, returns its id instead. PTY-backed kinds can't be presented as a dialog."
    ),
  size: z
    .enum(PLUGIN_PANEL_DIALOG_SIZES)
    .optional()
    .describe("Dialog width; dialog only. Default `6xl`."),
  toggle: z
    .boolean()
    .optional()
    .describe(
      "Dialog only. Close this kind's dialog instead when it is the topmost one for the worktree."
    ),
});

export function registerPanelCoreActions(
  actions: ActionRegistry,
  callbacks: ActionCallbacks
): void {
  actions.set("panel.list", () => ({
    id: "panel.list",
    title: "List panels",
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
    title: "Focus panel",
    description:
      "Move keyboard focus to a specific panel, changing what the user is looking at and where their typing goes. Use it to surface a panel the user should attend to. It reports nothing about the panel — list terminals or panels to inspect state.",
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
      // Selection and DOM focus are two states, and this action owes the caller
      // both. `activateTerminal` only moves selection — the pane grabs focus
      // from an effect keyed on *becoming* focused, so re-selecting the panel
      // that is already selected changes nothing and the keyboard stays
      // wherever it drifted (the sidebar, a dialog, the worktree list). Asking
      // the pane directly is what makes "focus this run" mean it every time.
      //
      // Unmounted panes report `false` here; that path is already covered,
      // because a pane that is not mounted was not focused either, so its
      // mount-time effect runs with `isFocused` already true.
      focusPanelInput(panelId);
    },
  }));

  actions.set("panel.openPluginPanel", () => ({
    id: "panel.openPluginPanel",
    title: "Open plugin panel",
    description:
      "Spawn (or focus an existing) plugin-contributed panel kind, handing it an initial argument. Args: `kind` (required) — the plugin panel kind id from `contributes.panels`; `initialArgs` (optional) — an opaque bag delivered to the view as `PanelViewProps.initialArgs` (e.g. `{ path }` to open a file); `worktreeId` (optional) — target worktree, which must belong to the current project; `reuseExisting` (optional, default true) — focus an existing panel of this kind in the worktree instead of spawning a second one; `presentation`, `size`, `toggle` (optional) — present the view as a modal dialog instead, which is ephemeral: closing it removes the panel and its persisted view state. Returns `{ panelId }`. Errors when `kind` is not a registered plugin panel kind, when `worktreeId` belongs to another project, or — transiently, retry — when the project's worktrees haven't loaded yet.",
    category: "panel",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: openPluginPanelArgsSchema,
    run: async (args: unknown) => {
      const { kind, initialArgs, worktreeId, reuseExisting, presentation, size, toggle } =
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

      // Both only mean something for a dialog. Ignoring them on a panel open
      // would turn a forgotten `presentation` into a silent grid spawn.
      if (presentation !== "dialog" && (toggle === true || size !== undefined)) {
        throw new Error('`toggle` and `size` apply only with `presentation: "dialog"`');
      }

      const state = usePanelStore.getState();
      const targetWorktreeId = worktreeId ?? callbacks.getActiveWorktreeId();

      if (presentation === "dialog") {
        // A PTY-backed kind commits its record only after the spawn resolves,
        // and the dialog host reads a missing record as a removal — the
        // reservation would be dropped before the terminal ever appeared.
        if (kindConfig.hasPty) {
          throw new Error(`"${kind}" is PTY-backed and can't be presented as a dialog`);
        }
        const dialogs = usePanelDialogStore.getState();
        // Same rule as grid reuse: a dialog for another worktree is not this
        // one, so it is neither returned nor toggled closed.
        const openOfKind = findPanelDialogsOfKind(dialogs, kind, targetWorktreeId);
        const topId = dialogs.dialogStack[dialogs.dialogStack.length - 1];
        if (toggle === true && topId !== undefined && openOfKind.includes(topId)) {
          dialogs.closePanelDialogById(topId);
          return { panelId: topId };
        }
        // A plain open never closes or re-creates a presented dialog of this
        // kind — that would discard the view's state for a "show it" request.
        const existingDialogId = openOfKind[openOfKind.length - 1];
        if (existingDialogId !== undefined) return { panelId: existingDialogId };

        const dialogId = await dialogs.openPanelDialog(
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- documented extension-panel spawn boundary, as the grid spawn below
          {
            kind,
            worktreeId: targetWorktreeId,
            extensionState: initialArgs,
          } as Parameters<typeof dialogs.openPanelDialog>[0],
          size ? { size } : undefined
        );
        if (!dialogId) {
          throw new Error(`Failed to open plugin panel "${kind}" as a dialog`);
        }
        return { panelId: dialogId };
      }

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
    title: "Panel palette",
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
    title: "Toggle diagnostics",
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
    title: "Show logs",
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
    title: "Show events",
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
    title: "Show problems",
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
    title: "Toggle portal",
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
