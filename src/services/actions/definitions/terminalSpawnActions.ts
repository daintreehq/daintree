import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { z } from "zod";
import { usePanelStore } from "@/store/panelStore";
import { useLayoutUndoStore } from "@/store/layoutUndoStore";
import {
  buildPanelDuplicateOptions,
  panelKindHasLaunchRoot,
  resolveInheritedPanelCwd,
} from "@/services/terminal/panelDuplicationService";
import { flushOptimisticCloses } from "@/services/terminal/optimisticPanelClose";
import { moveTerminalToWorktreeAndFollowRescue } from "@/services/terminal/crossWorktreeMove";
import { buildResumePanelOptions } from "@/services/agentResume";
import { getDefaultTitle } from "@/store/slices/panelRegistry/helpers";
import { getNarrowPanel } from "@/store/slices/panelRegistry/selectors";
import { TerminalSpawnSourceSchema, AddPanelFocusPolicySchema } from "./schemas";
import { requireExplicitTerminalIdForAgentDispatch } from "./terminalTargetBinding";
import { getCurrentViewStoreOrNull } from "@/store/createWorktreeStore";
import { isForegroundDispatch } from "./dispatchSource";
import type { AddPanelOptions } from "@/store/slices/panelRegistry/types";
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
    description:
      "Open a new terminal, ready for commands. This creates a visible panel and starts a shell process that consumes resources until it is closed. Defaults to the active worktree, and can instead open at a chosen directory and run something there immediately. Launch an agent instead when the intent is to start an AI CLI rather than a plain shell.",
    category: "terminal",
    kind: "command",
    // Stays statically safe: a plain "New Terminal" must not be gated. A
    // dispatch carrying `command` is elevated to "confirm" per-dispatch by
    // `resolveEffectiveActionDanger` — the same argument-keyed shape recipe
    // dispatches use, so agent-initiated shell execution is gated without
    // over-gating the ordinary case.
    danger: "safe",
    scope: "renderer",
    argsSchema: z
      .object({
        spawnedBy: TerminalSpawnSourceSchema.optional(),
        focusPolicy: AddPanelFocusPolicySchema.optional(),
        cwd: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Absolute directory to open the terminal in. Defaults to the active worktree's root."
          ),
        command: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Shell command to run in the new terminal immediately, instead of leaving it at a prompt. Supplying this requires a confirmation."
          ),
      })
      .optional(),
    run: async (args) => {
      const { spawnedBy, focusPolicy, cwd, command } = args ?? {};
      const addPanel = usePanelStore.getState().addPanel;
      const terminalId = await addPanel({
        kind: "terminal",
        cwd: cwd ?? callbacks.getDefaultCwd(),
        location: "grid",
        worktreeId: callbacks.getActiveWorktreeId(),
        spawnedBy,
        focusPolicy,
        ...(command !== undefined && { command }),
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
        // Land the copy directly after the panel it was copied from instead of
        // at the end of the list (#12095). Passed as an id, not a position:
        // `buildPanelDuplicateOptions` above can await agent-settings IPC, so
        // any index computed here would be stale by the time the store commits.
        options.insertAfterId = targetId;
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
          const reopenOptions: AddPanelOptions = {
            ...baseOptions,
            location: "grid",
            worktreeId: lastClosed.worktreeId ?? callbacks.getActiveWorktreeId(),
            ...(spawnedBy ? { spawnedBy } : {}),
          };
          // The worktree id above can fall back to the active worktree while
          // `cwd` still carries the closed panel's directory, so re-derive the
          // directory from whichever id actually won (#11854).
          if (panelKindHasLaunchRoot(reopenOptions.kind)) {
            reopenOptions.cwd = resolveInheritedPanelCwd(reopenOptions);
          }
          await state.addPanel(reopenOptions);
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
    description:
      "Move a terminal panel to a different worktree. The process is never restarted: a live " +
      "agent keeps running in the directory it launched from, and its pane offers to tell it " +
      "to continue there. A panel sharing a tab group travels with the rest of that group, " +
      "so this can relocate more than the panel named. The move is reversible. Name the " +
      "target: an automated caller cannot see what the user focused.",
    category: "terminal",
    kind: "command",
    // Relabelling a panel is reversible — drag it back — and nothing here
    // touches the running process, so there is no confirmation (#11853). The
    // pane's own banner is what surfaces the launch-root mismatch, and telling
    // the agent takes a second, explicit click.
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({
      terminalId: z.string().optional(),
      worktreeId: z.string().min(1),
    }),
    run: async (args: unknown, ctx) => {
      const { terminalId, worktreeId } = args as { terminalId?: string; worktreeId: string };
      requireExplicitTerminalIdForAgentDispatch("terminal.moveToWorktree", terminalId, ctx);
      const state = usePanelStore.getState();
      const targetId = terminalId ?? state.focusedId;
      if (targetId) {
        // Only a person who can see the panel gets a silent no-op; anything
        // headless — agent, plugin, or a source we don't recognise — is told,
        // because it cannot observe the difference between "moved" and
        // "nothing there" and would reason on from a false success.
        const reportsFailures = !isForegroundDispatch(ctx.dispatchSource);
        // `Object.hasOwn`, not a truthiness check: `panelsById` is a plain
        // object, so an id like "constructor" resolves off the prototype and
        // would be moved as if it were a real panel (same reason
        // `terminal.close` does this).
        if (!Object.hasOwn(state.panelsById, targetId)) {
          if (reportsFailures) {
            throw new Error(
              "terminal.moveToWorktree found no panel with that `terminalId` — it may have been closed. Re-read the terminal listing and pass a current panel id."
            );
          }
          return;
        }
        const terminal = state.panelsById[targetId];
        if (!terminal || terminal.worktreeId === worktreeId) {
          return;
        }
        // Checked for EVERY caller, not just headless ones: filing a panel
        // under an id no view can select hides a live process whoever asked for
        // it, and a menu row can go stale between opening and clicking. Only
        // the reporting differs. Verified when a view store can answer — the
        // accessor is null only before the provider mounts, which cannot
        // coexist with a panel to move, so there is nothing to fail closed on.
        const worktrees = getCurrentViewStoreOrNull()?.getState().worktrees;
        if (worktrees && !worktrees.has(worktreeId)) {
          if (reportsFailures) {
            throw new Error(
              "terminal.moveToWorktree found no open worktree with that `worktreeId`. Pass an id from the worktree listing, or create the worktree first and use the id it returns."
            );
          }
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
    description: "Create a new worktree and move this terminal panel to it",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ terminalId: z.string().optional() }).optional(),
    run: async (args: unknown, ctx) => {
      const { terminalId } = (args as { terminalId?: string } | undefined) ?? {};
      // Deliberately not in any tier allowlist, and guarded here anyway as
      // defense in depth — the same treatment `terminal.toggleMaximize` gets.
      // This action's whole gesture is the interactive create-worktree dialog
      // (#11853): the move happens in the dialog's `onCreated` callback, which
      // a headless caller can never answer, and `run()` has already returned by
      // then. Allowlisting it would hang a modal in front of the user and
      // report a move that never happened (#11532, #11877). An agent that wants
      // a panel in a fresh worktree creates the worktree with the headless
      // worktree-creation capability, then moves the panel to the id it
      // returns.
      if (ctx.dispatchSource === "agent") {
        throw new Error(
          'terminal.moveToNewWorktree can\'t be dispatched by an agent or MCP client — it opens the new-worktree dialog, which a headless caller can never answer. Don\'t retry it. Create the worktree headlessly with `worktree.createWithRecipe` (pass `source: { kind: "newBranch", branchName: "..." }`, and omit `recipeId` when no recipe is wanted), then call `terminal.moveToWorktree` with the original `terminalId` and the `worktreeId` it returns.'
        );
      }
      const state = usePanelStore.getState();
      const targetId = terminalId ?? state.focusedId;
      if (!targetId) return;
      state.moveToNewWorktree(targetId);
    },
  }));
}
