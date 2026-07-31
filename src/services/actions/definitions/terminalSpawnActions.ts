import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { z } from "zod";
import { usePanelStore } from "@/store/panelStore";
import { useLayoutUndoStore } from "@/store/layoutUndoStore";
import { buildPanelDuplicateOptions } from "@/services/terminal/panelDuplicationService";
import { flushOptimisticCloses } from "@/services/terminal/optimisticPanelClose";
import { moveTerminalToWorktreeAndFollowRescue } from "@/services/terminal/crossWorktreeMove";
import { buildResumePanelOptions } from "@/services/agentResume";
import { getDefaultTitle } from "@/store/slices/panelRegistry/helpers";
import { getNarrowPanel } from "@/store/slices/panelRegistry/selectors";
import { TerminalSpawnSourceSchema, AddPanelFocusPolicySchema } from "./schemas";
import type { PtyPanelData, TerminalSpawnSource } from "@shared/types/panel";
import { isPtyPanel } from "@shared/types/panel";

// Guards the async journal-resume fallback of `terminal.reopenLast` against a
// second dispatch racing the first's pending `list`/`addPanel` — two rapid
// presses could otherwise both pass the duplicate scan and spawn two terminals
// resuming the same transcript. Module-scoped, so it's per project view (each
// view has its own module instance), matching the worktree scope of the guard.
let reopenJournalInFlight = false;

export function registerTerminalSpawnActions(
  actions: ActionRegistry,
  callbacks: ActionCallbacks
): void {
  actions.set("terminal.new", () => ({
    id: "terminal.new",
    title: "New Terminal",
    description: "Create a new terminal in the active worktree",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    mcpVisibility: "core",
    argsSchema: z
      .object({
        spawnedBy: TerminalSpawnSourceSchema.optional(),
        focusPolicy: AddPanelFocusPolicySchema.optional(),
      })
      .optional(),
    run: async (args) => {
      const { spawnedBy, focusPolicy } = args ?? {};
      const addPanel = usePanelStore.getState().addPanel;
      const terminalId = await addPanel({
        kind: "terminal",
        cwd: callbacks.getDefaultCwd(),
        location: "grid",
        worktreeId: callbacks.getActiveWorktreeId(),
        spawnedBy,
        focusPolicy,
      });
      if (!terminalId) return;
      return { terminalId };
    },
  }));

  actions.set("terminal.resumeSessions", () => ({
    id: "terminal.resumeSessions",
    title: "Resume Session…",
    description: "Browse and resume a closed agent session in this project",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["resume", "reopen", "closed", "history", "session", "restore"],
    nonRepeatable: true,
    // Opens a modal palette — a post-dispatch hint would land on top of it
    // (ShortcutHint sits at z-toast, above z-modal). Issue #11030.
    // Not redundant with dispatch()'s overlay-claim check (#11507): this
    // opener is synchronous, so the continuation can beat the palette's
    // claim effect. Keep the flag.
    suppressShortcutHint: true,
    run: async () => {
      callbacks.onOpenResumeSessionsPalette();
    },
  }));

  actions.set("terminal.duplicate", () => ({
    id: "terminal.duplicate",
    title: "Duplicate Panel",
    description: "Duplicate the focused panel, or create a new terminal if no panels exist",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z
      .object({
        terminalId: z.string().optional(),
        spawnedBy: TerminalSpawnSourceSchema.optional(),
        focusPolicy: AddPanelFocusPolicySchema.optional(),
      })
      .optional(),
    run: async (args: unknown) => {
      const { terminalId, spawnedBy, focusPolicy } =
        (args as
          | {
              terminalId?: string;
              spawnedBy?: TerminalSpawnSource;
              focusPolicy?: "auto" | "preserve" | "take";
            }
          | undefined) ?? {};
      const state = usePanelStore.getState();
      const nonTrashed = state.panelIds
        .map((id) => state.panelsById[id])
        // Ephemeral dialog panels are never the implicit duplicate target: with
        // only a file dialog open, "the one panel" would resolve to it and the
        // duplicate would fail on an unsupported kind.
        .filter((t) => t && t.location !== "trash" && t.location !== "dialog");
      const focusedPanel = state.focusedId ? state.panelsById[state.focusedId] : undefined;
      const liveFocusedId =
        focusedPanel && focusedPanel.location !== "trash" ? state.focusedId : undefined;
      const targetId =
        terminalId ?? liveFocusedId ?? (nonTrashed.length === 1 ? nonTrashed[0]!.id : undefined);

      if (targetId) {
        const terminal = state.panelsById[targetId];
        if (!terminal) return;

        const narrowedTerminal = getNarrowPanel(state.panelsById, targetId);
        if (!narrowedTerminal) return;

        const location =
          terminal.location === "grid" || terminal.location === "dock" ? terminal.location : "grid";
        const options = await buildPanelDuplicateOptions(narrowedTerminal, location);
        if (options.title) {
          const defaultTitle = getDefaultTitle(terminal.kind, terminal);
          if (options.title !== defaultTitle) {
            options.title = `${options.title} (copy)`;
          }
        }
        if (spawnedBy) {
          options.spawnedBy = spawnedBy;
        }
        if (focusPolicy) {
          options.focusPolicy = focusPolicy;
        }
        await state.addPanel(options);
      } else if (nonTrashed.length === 0) {
        const lastClosed = state.lastClosedConfig;
        if (lastClosed) {
          const baseOptions = lastClosed.launchAgentId
            ? await buildPanelDuplicateOptions(
                {
                  id: "last-closed",
                  kind: "terminal",
                  cols: 80,
                  rows: 24,
                  title: lastClosed.title ?? "Terminal",
                  cwd: lastClosed.cwd ?? callbacks.getDefaultCwd(),
                  location: "grid",
                  ...lastClosed,
                } as PtyPanelData,
                "grid"
              )
            : lastClosed;
          await state.addPanel({
            ...baseOptions,
            location: "grid",
            worktreeId: lastClosed.worktreeId ?? callbacks.getActiveWorktreeId(),
            ...(spawnedBy ? { spawnedBy } : {}),
          });
        } else {
          await state.addPanel({
            kind: "terminal",
            cwd: callbacks.getDefaultCwd(),
            location: "grid",
            worktreeId: callbacks.getActiveWorktreeId(),
            spawnedBy,
          });
        }
      }
    },
  }));

  actions.set("terminal.reopenLast", () => ({
    id: "terminal.reopenLast",
    title: "Reopen Last Closed",
    description:
      "Restore the most recently trashed terminal, or resume the most recent journaled agent session once the trash window has lapsed",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      // Commit any in-flight optimistic close first — until it flushes the
      // panel isn't in `trashedTerminals` yet and restore would no-op.
      flushOptimisticCloses();
      // Fast path: restore from the in-memory trash while its window is open.
      if (usePanelStore.getState().restoreLastTrashed()) return;

      // Fallback: the trash window has lapsed. Resume the most recent journaled
      // session for the active worktree. Scope to the active worktree so the
      // resumed record's cwd matches the directory we launch into — session
      // resume is directory-scoped (#4781); a globally-newest record could be
      // relaunched into the wrong worktree.
      if (reopenJournalInFlight) return;
      const activeWorktreeId = callbacks.getActiveWorktreeId();
      if (!activeWorktreeId) return;
      // Freeze the cwd alongside the worktree id BEFORE the await: both are live
      // getters (useActionRegistry's ref proxy), so a worktree switch mid-IPC
      // would otherwise pair this record's worktree with a different worktree's
      // cwd — the exact directory mismatch #4781 warns about.
      const cwd = callbacks.getDefaultCwd();

      reopenJournalInFlight = true;
      try {
        const sessions = await (window.electron?.agentSessionHistory
          ?.list(activeWorktreeId)
          .catch(() => []) ?? Promise.resolve([]));
        const session = sessions[0];
        if (!session) return;

        const options = buildResumePanelOptions(session, { cwd, worktreeId: activeWorktreeId });
        if (!options) return;

        // Records are non-destructive/unconsumed, so a repeat press would try to
        // resume the same session again — concurrent transcript access. If a live
        // panel in this worktree already carries the session, focus it instead of
        // respawning. Scope by worktree too so a panel moved to another worktree
        // can't steal focus across worktrees.
        const state = usePanelStore.getState();
        const existingId = state.panelIds.find((id) => {
          const panel = state.panelsById[id];
          return (
            panel &&
            isPtyPanel(panel) &&
            panel.location !== "trash" &&
            panel.agentSessionId === session.sessionId &&
            panel.worktreeId === activeWorktreeId
          );
        });
        if (existingId) {
          state.activateTerminal(existingId);
          return;
        }

        await state.addPanel(options);
      } finally {
        reopenJournalInFlight = false;
      }
    },
  }));

  actions.set("terminal.moveToWorktree", () => ({
    id: "terminal.moveToWorktree",
    title: "Move to Worktree",
    description: "Move terminal to a different worktree",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({
      terminalId: z.string().optional(),
      worktreeId: z.string(),
    }),
    run: async (args: unknown) => {
      const { terminalId, worktreeId } = args as { terminalId?: string; worktreeId: string };
      const state = usePanelStore.getState();
      const targetId = terminalId ?? state.focusedId;
      if (targetId) {
        const terminal = state.panelsById[targetId];
        if (!terminal || terminal.worktreeId === worktreeId) {
          return;
        }

        useLayoutUndoStore.getState().pushLayoutSnapshot();
        moveTerminalToWorktreeAndFollowRescue(targetId, worktreeId);
      }
    },
  }));

  actions.set("terminal.moveToNewWorktree", () => ({
    id: "terminal.moveToNewWorktree",
    title: "Move to New Worktree…",
    description: "Create a new worktree and transfer the agent session there",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ terminalId: z.string().optional() }).optional(),
    run: async (args: unknown) => {
      const { terminalId } = (args as { terminalId?: string } | undefined) ?? {};
      const state = usePanelStore.getState();
      const targetId = terminalId ?? state.focusedId;
      if (!targetId) return;
      state.moveToNewWorktreeAndTransfer(targetId);
    },
  }));
}
