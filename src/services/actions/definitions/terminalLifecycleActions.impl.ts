// The terminal lifecycle actions' run bodies, loaded on first dispatch by
// `runTerminalLifecycleAction` in terminalLifecycleActions.ts, which keeps the
// metadata every view registers at boot (#14273). Nothing here may import
// terminalLifecycleActions.ts at runtime.
import type { ActionContext } from "@shared/types/actions";
import {
  ConfirmationStagedError,
  confirmationStagedMessage,
} from "@/services/actions/confirmationStaged";
import { terminalClient } from "@/clients";
import { peek as peekTerminalService } from "@/services/terminal/terminalInstanceServiceAccessor";
import { requestPanelClose } from "@/services/terminal/optimisticPanelClose";
import { consultPanelCloseGuards, hasPanelCloseGuard } from "@/services/panelCloseGuard";
import { fireWatchNotification } from "@/lib/watchNotification";
import { usePanelStore } from "@/store/panelStore";
import { useRateLimitObservationStore } from "@/store/rateLimitObservationStore";
import { isPtyPanel } from "@shared/types/panel";
import {
  useTerminalPendingDestructiveActionStore,
  type TerminalPendingDestructiveActionKind,
  type TerminalPendingDestructiveActionSnapshot,
} from "@/store/terminalPendingDestructiveActionStore";
import {
  buildDestructivePreview,
  collectRunningAgentTerminals,
  terminalHasRunningAgentSession,
} from "@/utils/destructiveSessionConfirm";
import { isEphemeralPanel } from "@/store/slices/panelRegistry/panelCount";
import { requireExplicitTerminalIdForAgentDispatch } from "./terminalTargetBinding";
import {
  assertPlacementAllowed,
  confirmPlacement,
  resolvePlacementTarget,
  throwTerminalMiss,
} from "./terminalPlacement";
import { isForegroundDispatch } from "./dispatchSource";
import { readTerminalPaneInfo } from "@/services/terminal/readTerminalPaneInfo";
import {
  isRestoreRecoveryLaunching,
  launchFromRestoreRecovery,
} from "@/services/terminal/restoreRecoveryLaunch";
import { UnactionableTargetError } from "@/services/actions/unactionableTarget";
import { logWarn } from "@/utils/logger";
import {
  RestartOnPresetArgsSchema,
  SetHoldOnRestartArgsSchema,
  StartHeldArgsSchema,
  TerminalKillBatchArgsSchema,
} from "./terminalLifecycleActionArgs";

function parseConfirmed(args: unknown): boolean {
  if (!args || typeof args !== "object") return false;
  return (args as { confirmed?: unknown }).confirmed === true;
}

/**
 * Has this dispatch's destructive step already been approved?
 *
 * Two independent surfaces, deliberately. `args.confirmed` is how the in-app
 * dialogs re-dispatch after the user clicks through: client-settable, which is
 * harmless because it only skips the gate below — `ActionService` still made an
 * agent clear the host modal to get here at all. `ctx.hostConfirmed` is that
 * host attestation itself, stamped by `ActionService.dispatch` and unspoofable.
 *
 * Reading only the first is what made an MCP kill ask twice and kill nothing
 * (#12120): the bridge sets the attestation in the dispatch options and leaves
 * the model's args alone, so the approval the user had already given was
 * invisible here.
 *
 * Deliberately NOT `ctx.dispatchSource === "agent"`. That reads as the same
 * thing only for a statically `danger:"confirm"` action; where the tier is
 * escalated from the args (`resolveEffectiveActionDanger`), an agent reaches
 * `run()` with no approval at all and the inference becomes a silent bypass.
 */
function isConfirmed(args: unknown, ctx: ActionContext | undefined): boolean {
  return parseConfirmed(args) || ctx?.hostConfirmed === true;
}

/**
 * Park a confirmation for the user, and refuse the dispatch.
 *
 * Never returns — staging is not success. Returning normally here resolved the
 * dispatch as `ok` while the terminal was still running, so an agent read a
 * staged kill as a completed one and moved on (#12120). Same shape as the
 * panel-limit refusal (#8814): a `run()` that declines to act must throw, or
 * `dispatch` reports success for nothing happening.
 */
function stageConfirmation(
  snapshot: TerminalPendingDestructiveActionSnapshot,
  what: string
): never {
  useTerminalPendingDestructiveActionStore.getState().request(snapshot);
  throw new ConfirmationStagedError(confirmationStagedMessage(what));
}

function clearPendingIf(kind: TerminalPendingDestructiveActionKind): void {
  const pending = useTerminalPendingDestructiveActionStore.getState().pending;
  if (pending && pending.kind === kind) {
    useTerminalPendingDestructiveActionStore.getState().clear();
  }
}

/** Why `terminal.startHeld` can't start this pane as it stands, or undefined if it can. */
function startHeldRefusal(terminalId: string, start: "resume" | "fresh"): string | undefined {
  const panel = usePanelStore.getState().panelsById[terminalId];
  if (!panel || !isPtyPanel(panel)) return `No terminal '${terminalId}' in this project.`;
  if (panel.location !== "grid" && panel.location !== "dock") {
    return `Terminal '${terminalId}' is in the ${panel.location}; only a held pane in the grid or dock can start.`;
  }
  // Ahead of the hold checks: a launch clears the hold before it finishes, and
  // a pane mid-start must not be sent to terminal.restart.
  if (isRestoreRecoveryLaunching(terminalId)) {
    return `Terminal '${terminalId}' is already starting. Watch its status rather than starting it again.`;
  }
  const recovery = panel.restoreRecovery;
  if (!recovery) {
    return `Terminal '${terminalId}' isn't held for recovery; use terminal.restart for a running one.`;
  }
  if (recovery.awaitingDestination) {
    return `Terminal '${terminalId}' is waiting for a worktree to run in. Move it onto one, or keep its original folder from the pane.`;
  }
  if (start === "resume" && recovery.sessionId === undefined) {
    return `Terminal '${terminalId}' was held (${recovery.reason}) with no recorded conversation to resume. Start it fresh, or leave the pane for the user to pick one.`;
  }
  return undefined;
}

export const terminalLifecycleActionRuns = {
  "terminal.trash": async (args: unknown, ctx: ActionContext, focusedAtDispatch: string | null) => {
    const { terminalId } = args as { terminalId?: string };
    requireExplicitTerminalIdForAgentDispatch("terminal.trash", terminalId, ctx);
    const state = usePanelStore.getState();
    const targetId = terminalId ?? focusedAtDispatch;
    if (targetId) {
      const target = state.panelsById[targetId];
      if (target?.location === "grid" || target?.location === undefined) {
        requestPanelClose({
          hideIds: [targetId],
          commit: () => usePanelStore.getState().trashPanel(targetId),
        });
      } else if (hasPanelCloseGuard(targetId)) {
        // A docked panel with unsaved work still asks before it is trashed.
        const proceed = await consultPanelCloseGuards([targetId]);
        if (proceed) usePanelStore.getState().trashPanel(targetId);
      } else {
        state.trashPanel(targetId);
      }
    }
  },
  "terminal.background": async (
    args: unknown,
    ctx: ActionContext,
    focusedAtDispatch: string | null
  ) => {
    const { terminalId } = (args as { terminalId?: string } | undefined) ?? {};
    requireExplicitTerminalIdForAgentDispatch("terminal.background", terminalId, ctx);
    const state = usePanelStore.getState();
    // A named panel this view does not hold fails like `terminal.close`'s
    // miss: the store movers ignore an unknown id, so without this the call
    // answered ok for a panel that never moved (#13663).
    if (terminalId !== undefined && !Object.hasOwn(state.panelsById, terminalId)) {
      return throwTerminalMiss("terminal.background", terminalId);
    }
    const targetId = resolvePlacementTarget(terminalId, {
      focusedId: focusedAtDispatch,
      panelsById: state.panelsById,
      getPanelGroup: state.getPanelGroup,
    });
    if (!targetId) return { location: null };
    if (assertPlacementAllowed("terminal.background", targetId, "background", state)) {
      return { location: "background" as const };
    }
    if (state.getPanelGroup(targetId)) {
      state.backgroundPanelGroup(targetId);
    } else {
      state.backgroundTerminal(targetId);
    }
    return confirmPlacement(
      "terminal.background",
      targetId,
      "background",
      usePanelStore.getState().panelsById[targetId]
    );
  },
  "terminal.kill": async (args: unknown, ctx: ActionContext, focusedAtDispatch: string | null) => {
    const { terminalId } = args as { terminalId?: string };
    // Ahead of the pending-destructive request below: an unbound agent call
    // must not stage a confirm dialog asking the user to approve killing
    // whatever they happen to be looking at.
    requireExplicitTerminalIdForAgentDispatch("terminal.kill", terminalId, ctx);
    const state = usePanelStore.getState();
    const targetId = terminalId ?? focusedAtDispatch;
    if (!targetId) return;
    const terminal = state.panelsById[targetId];
    // Bare PTY stays D0 — only confirm when an agent session would lose
    // in-flight work. Mid-work is "working"; "waiting"/"directing" are
    // paused states where stopping is non-disruptive.
    if (!isConfirmed(args, ctx) && terminalHasRunningAgentSession(terminal)) {
      stageConfirmation(
        {
          kind: "kill",
          dispatchSource: ctx?.dispatchSource,
          targetCount: 1,
          runningAgentCount: 1,
          terminalId: targetId,
          terminalTitle: terminal?.title,
        },
        "Killing this terminal"
      );
    }
    clearPendingIf("kill");
    state.removePanel(targetId);
  },
  "terminal.killBatch": async (args: unknown, ctx: ActionContext) => {
    // Re-parsed rather than asserted. `ActionService` has already validated
    // against this exact schema, so this cannot throw on the dispatch path —
    // it just buys the narrowed type without an unchecked cast, and keeps
    // `run()` honest if it is ever called outside the service.
    const { terminalIds } = TerminalKillBatchArgsSchema.parse(args);
    // The per-target attestation is what this action runs on, and it exists
    // only when a selectable host confirmation actually resolved. Refusing on
    // its absence is the whole gate: `hostConfirmed` alone says a human
    // approved *something*, and reading that as "approved all of these" is
    // exactly the sweep the deselectable dialog exists to prevent. Nothing
    // else dispatches this action, so a missing attestation is a wiring bug,
    // never a user in a hurry.
    const approved = ctx?.hostApprovedTargets;
    if (approved === undefined) {
      throw new Error(
        "terminal.killBatch requires a per-target approval from the host confirmation; nothing was destroyed."
      );
    }
    // Only ids the call actually asked for. An attestation naming anything
    // else is not consent about this batch.
    const requested = new Set(terminalIds);
    const observedAgentById = new Map(
      approved
        .filter((target) => requested.has(target.id))
        .map((target) => [target.id, target.observedAgentRunning] as const)
    );

    const killedIds: string[] = [];
    const excludedIds: string[] = [];
    const notFoundIds: string[] = [];
    const skippedIds: string[] = [];
    const failedIds: string[] = [];

    for (const id of terminalIds) {
      if (!observedAgentById.has(id)) {
        excludedIds.push(id);
        continue;
      }
      // Re-read per id rather than snapshotting once before the loop: each
      // removal mutates the store, and an agent can start working in a
      // later target while an earlier one is being torn down.
      const state = usePanelStore.getState();
      // `Object.hasOwn`, not truthiness: `panelsById` is a plain object, so
      // an id like "constructor" would otherwise resolve off the prototype
      // and get removed as if it were a real panel.
      if (!Object.hasOwn(state.panelsById, id)) {
        notFoundIds.push(id);
        continue;
      }
      const terminal = state.panelsById[id];
      // The revalidation the approval is bound to. Only escalation counts: a
      // row the approver saw running an agent and approved anyway still dies,
      // and one that has since gone idle is strictly less than what they
      // approved. A row shown idle that is now mid-work is the one case the
      // approval never covered.
      if (observedAgentById.get(id) !== true && terminalHasRunningAgentSession(terminal)) {
        skippedIds.push(id);
        continue;
      }
      // Contained per target, and that containment is the point. Letting a
      // teardown throw escape would abandon the rest of the approved batch
      // AND discard the record of the kills that already happened — for an
      // irreversible action, a caller told only "execution error" cannot
      // know what it lost, and its natural next move is to retry.
      try {
        state.removePanel(id);
        killedIds.push(id);
      } catch (err) {
        logWarn("terminal.killBatch: removePanel threw", { terminalId: id, error: err });
        failedIds.push(id);
      }
    }

    return { killedIds, excludedIds, notFoundIds, skippedIds, failedIds };
  },
  "terminal.restart": async (
    args: unknown,
    ctx: ActionContext,
    focusedAtDispatch: string | null
  ) => {
    const { terminalId } = args as { terminalId?: string };
    // See terminal.kill: guard before the confirm request is staged.
    requireExplicitTerminalIdForAgentDispatch("terminal.restart", terminalId, ctx);
    const state = usePanelStore.getState();
    const targetId = terminalId ?? focusedAtDispatch;
    if (!targetId) return;
    const terminal = state.panelsById[targetId];
    // `restartTerminal` only logs its refusal of a held pane, so without this
    // the caller reads a pane still waiting for its conversation as restarted
    // and launches a replacement beside it (#15270).
    if (terminal && isPtyPanel(terminal) && terminal.restoreRecovery) {
      throw new UnactionableTargetError(
        `Terminal '${targetId}' is held for recovery (${terminal.restoreRecovery.reason}) and hasn't started, so there's nothing to restart. Start it in place with terminal.startHeld.`
      );
    }
    if (!isConfirmed(args, ctx) && terminalHasRunningAgentSession(terminal)) {
      stageConfirmation(
        {
          kind: "restart",
          dispatchSource: ctx?.dispatchSource,
          targetCount: 1,
          runningAgentCount: 1,
          terminalId: targetId,
          terminalTitle: terminal?.title,
        },
        "Restarting this terminal"
      );
    }
    clearPendingIf("restart");
    state.restartTerminal(targetId);
  },
  "terminal.startHeld": async (args: unknown) => {
    const { terminalId, start } = StartHeldArgsSchema.parse(args);
    const refusal = startHeldRefusal(terminalId, start);
    if (refusal !== undefined) throw new UnactionableTargetError(refusal);
    const panel = usePanelStore.getState().panelsById[terminalId];
    // Only the conversation the hold recorded, never one the caller names:
    // choosing among the rest is what the hold leaves to the user (#12434).
    const sessionId =
      start === "resume" && panel && isPtyPanel(panel)
        ? panel.restoreRecovery?.sessionId
        : undefined;
    const outcome = await launchFromRestoreRecovery(
      terminalId,
      sessionId !== undefined ? { kind: "resume", sessionId } : { kind: "fresh" }
    );
    if (outcome === "held-elsewhere") {
      throw new UnactionableTargetError(
        `Another pane already has conversation '${sessionId}' open, or is opening it.`
      );
    }
    if (outcome === "unavailable") {
      // Read again: another start of this pane, or its closing, while this one
      // waited is not a failed launch, and a caller told only "didn't launch"
      // starts a replacement beside a pane that is already coming up.
      const after = startHeldRefusal(terminalId, start);
      if (after !== undefined) throw new UnactionableTargetError(after);
      throw new Error(`Terminal '${terminalId}' is still held: its launch didn't go through.`);
    }
    return { terminalId, start, ...(sessionId !== undefined && { sessionId }) };
  },
  "terminal.restartOnPreset": async (
    args: unknown,
    ctx: ActionContext,
    focusedAtDispatch: string | null
  ) => {
    const { terminalId, presetId } = RestartOnPresetArgsSchema.parse(args);
    requireExplicitTerminalIdForAgentDispatch("terminal.restartOnPreset", terminalId, ctx);
    // Unlike terminal.restart, this asks whatever the agent is doing: the
    // conversation can't follow the pane to another preset's home, and a
    // rate-limited agent is rarely `working` (#13746).
    if (!isConfirmed(args, ctx)) {
      throw new Error("Restarting on another preset ends the conversation; pass confirmed: true");
    }
    const state = usePanelStore.getState();
    const targetId = terminalId ?? focusedAtDispatch;
    if (!targetId) throw new Error("No terminal to restart on that preset");
    const observedBefore = useRateLimitObservationStore.getState().observedAtByTerminalId[targetId];
    const result = await state.restartTerminalOnPreset(targetId, presetId);
    if (!result.success) {
      throw new Error(result.error ?? "Couldn't restart the terminal on that preset");
    }
    // The chip reported this pane's old account. Only that observation goes:
    // the new process may already have reported one of its own.
    if (observedBefore !== undefined) {
      useRateLimitObservationStore.getState().clearObservation(targetId, observedBefore);
    }
    // Read back rather than echoed: the store records the preset it resolved.
    const restarted = usePanelStore.getState().panelsById[targetId];
    return {
      terminalId: targetId,
      agentPresetId:
        (restarted && isPtyPanel(restarted) ? restarted.agentPresetId : undefined) ?? presetId,
      agentSessionIdCleared: true as const,
    };
  },
  "terminal.redraw": async (
    args: unknown,
    ctx: ActionContext,
    focusedAtDispatch: string | null
  ) => {
    const { terminalId } = (args as { terminalId?: string } | undefined) ?? {};
    requireExplicitTerminalIdForAgentDispatch("terminal.redraw", terminalId, ctx);
    const targetId = terminalId ?? focusedAtDispatch;
    if (targetId) {
      // Only a PERSON gets the bypass (#11638). #10863's write-quiescence
      // deferral exists to stop an automatic out-of-band re-wrap landing
      // under a live cursor-relative repaint, and a busy agent never opens
      // the 300ms gap it waits for — so a human staring at a garbled pane
      // needs to skip it, but a plugin or agent driving this action on a
      // timer IS the automatic writer the guard was written for. Non-
      // foreground dispatch still gets the renderer repair, just with the
      // deferral intact.
      peekTerminalService()?.resetRenderer(targetId, {
        force: isForegroundDispatch(ctx?.dispatchSource),
      });
    }
  },
  "terminal.rename": async (
    args: unknown,
    ctx: ActionContext,
    focusedAtDispatch: string | null
  ) => {
    const { terminalId, name } = args as { terminalId?: string; name?: string };
    requireExplicitTerminalIdForAgentDispatch("terminal.rename", terminalId, ctx);
    // Second, independent requirement: without a `name` this action defers to
    // the interactive rename dialog, which a headless caller can never answer
    // — it would hang a prompt in front of the user instead (#11532). Tested
    // against `undefined` rather than falsiness because "" is meaningful: it
    // restores the identity-derived default title.
    if (ctx.dispatchSource === "agent" && name === undefined) {
      throw new Error(
        "terminal.rename requires an explicit `name` when dispatched by an agent or MCP client — a headless caller cannot answer the rename dialog. Pass the new title in `name`, or an empty string to restore the default."
      );
    }
    const targetId = terminalId ?? focusedAtDispatch;
    if (!targetId) return undefined;

    if (name !== undefined) {
      // Programmatic renames (MCP, assistant, plugins) are automation-tier:
      // they pin `titleMode: "custom"` and bounce off a user lock.
      usePanelStore.getState().updateTitle(targetId, name, "automation");
      // The title the tab now shows, so a caller learns a hand-set title
      // kept its place without listing terminals again.
      // An automation rename is ignored only under a user's lock.
      const panel = usePanelStore.getState().panelsById[targetId];
      return {
        terminalId: targetId,
        title: panel?.title ?? null,
        applied: panel !== undefined && panel.titleMode !== "user",
      };
    } else {
      // Defer to a macrotask so menu/dropdown close handlers run before the
      // title input mounts. Do not use requestAnimationFrame here: CI Linux
      // windows can throttle rAF enough that the rename event never fires.
      window.setTimeout(() => {
        window.dispatchEvent(
          new CustomEvent("daintree:rename-terminal", { detail: { id: targetId } })
        );
      }, 0);
      return undefined;
    }
  },
  "terminal.viewInfo": async (
    args: unknown,
    ctx: ActionContext,
    focusedAtDispatch: string | null
  ) => {
    const { terminalId } = args as { terminalId?: string };
    requireExplicitTerminalIdForAgentDispatch("terminal.viewInfo", terminalId, ctx);
    const targetId = terminalId ?? focusedAtDispatch;
    if (targetId) {
      window.dispatchEvent(
        new CustomEvent("daintree:open-terminal-info", { detail: { id: targetId } })
      );
    }
  },
  "terminal.info.open": async (
    args: unknown,
    ctx: ActionContext,
    focusedAtDispatch: string | null
  ) => {
    const { terminalId } = args as { terminalId?: string };
    requireExplicitTerminalIdForAgentDispatch("terminal.info.open", terminalId, ctx);
    const targetId = terminalId ?? focusedAtDispatch;
    if (targetId) {
      window.dispatchEvent(
        new CustomEvent("daintree:open-terminal-info", { detail: { id: targetId } })
      );
    }
  },
  "terminal.info.get": async (
    args: unknown,
    ctx: ActionContext,
    focusedAtDispatch: string | null
  ) => {
    const { terminalId } = (args as { terminalId?: string } | undefined) ?? {};
    // Supersedes the "No terminal selected" throw below for agent dispatch:
    // that one only fires when nothing is focused either, so an agent would
    // otherwise get a silent read of the wrong terminal whenever focus exists.
    requireExplicitTerminalIdForAgentDispatch("terminal.info.get", terminalId, ctx);
    const targetId = terminalId ?? focusedAtDispatch;
    if (!targetId) {
      throw new Error("No terminal selected");
    }
    return await readTerminalPaneInfo(targetId);
  },
  "terminal.sessionFile.get": async (args: unknown, ctx: ActionContext) => {
    const { terminalId } = args as { terminalId: string };
    // The caller comes off the host-stamped context, never an argument.
    if (ctx?.dispatchSource !== "plugin" || !ctx.callerPluginId) {
      throw new UnactionableTargetError(
        "Only a plugin can look up the session file a terminal's agent is writing."
      );
    }
    return await window.electron.terminalSessionFile.get({ terminalId });
  },
  "terminal.setHoldOnRestart": async (args: unknown, ctx: ActionContext) => {
    const { terminalId, hold } = SetHoldOnRestartArgsSchema.parse(args);
    // Who launched the pane comes off the host-stamped context, never an
    // argument, so one plugin can't hold or release another's panes.
    const caller = ctx?.dispatchSource === "plugin" ? ctx.callerPluginId : undefined;
    if (caller === undefined) {
      throw new UnactionableTargetError(
        "Only the plugin that launched a terminal can hold it on restart."
      );
    }
    const panel = usePanelStore.getState().panelsById[terminalId];
    if (
      !panel ||
      !isPtyPanel(panel) ||
      !panel.launchAgentId ||
      panel.launchedByPluginId !== caller
    ) {
      throw new UnactionableTargetError(
        `No agent terminal '${terminalId}' launched by this plugin in this project.`
      );
    }
    usePanelStore.getState().setHoldOnRestart(terminalId, hold);
    return { terminalId, holdOnRestart: hold };
  },
  "terminal.toggleInputLock": async (
    args: unknown,
    ctx: ActionContext,
    focusedAtDispatch: string | null
  ) => {
    const { terminalId } = args as { terminalId?: string };
    requireExplicitTerminalIdForAgentDispatch("terminal.toggleInputLock", terminalId, ctx);
    const state = usePanelStore.getState();
    const targetId = terminalId ?? focusedAtDispatch;
    if (targetId) {
      state.toggleInputLocked(targetId);
    }
  },
  "terminal.forceResume": async (
    args: unknown,
    ctx: ActionContext,
    focusedAtDispatch: string | null
  ) => {
    const { terminalId } = args as { terminalId?: string };
    requireExplicitTerminalIdForAgentDispatch("terminal.forceResume", terminalId, ctx);
    const targetId = terminalId ?? focusedAtDispatch;
    if (targetId) {
      await terminalClient.forceResume(targetId);
    }
  },

  "terminal.killAll": async (args: unknown, ctx: ActionContext) => {
    // Don't reuse bulkCloseAll() — it indiscriminately removes every panel,
    // including the tooling-internal assistant terminal. Filter those out
    // before issuing per-panel removes.
    const state = usePanelStore.getState();
    const targets = state.panelIds
      .map((id) => state.panelsById[id])
      .filter((t): t is NonNullable<typeof t> => {
        if (t == null) return false;
        return !isEphemeralPanel(t);
      });
    if (targets.length === 0) return;
    const runningAgents = collectRunningAgentTerminals(targets);
    if (!isConfirmed(args, ctx) && runningAgents.length > 0) {
      stageConfirmation(
        {
          kind: "killAll",
          dispatchSource: ctx?.dispatchSource,
          targetCount: targets.length,
          runningAgentCount: runningAgents.length,
          preview: buildDestructivePreview(targets),
        },
        "Killing every terminal"
      );
    }
    clearPendingIf("killAll");
    targets.forEach((t) => state.removePanel(t.id));
  },
  "terminal.restartAll": async (args: unknown, ctx: ActionContext) => {
    const state = usePanelStore.getState();
    // Location-only, deliberately narrower than `isEphemeralPanel`: this list
    // must match what `bulkRestartAll` actually restarts, and that still
    // includes `excludeFromPersistence` terminals like the assistant.
    // Excluding them here alone would confirm one set and restart another.
    const targets = state.panelIds
      .map((id) => state.panelsById[id])
      .filter(
        (t): t is NonNullable<typeof t> =>
          t != null && t.location !== "trash" && t.location !== "dialog"
      );
    if (targets.length === 0) return;
    const runningAgents = collectRunningAgentTerminals(targets);
    if (!isConfirmed(args, ctx) && runningAgents.length > 0) {
      stageConfirmation(
        {
          kind: "restartAll",
          dispatchSource: ctx?.dispatchSource,
          targetCount: targets.length,
          runningAgentCount: runningAgents.length,
          preview: buildDestructivePreview(targets),
        },
        "Restarting every terminal"
      );
    }
    clearPendingIf("restartAll");
    await state.bulkRestartAll();
  },
  "terminal.restartService": async () => {
    await terminalClient.restartService();
  },
  "terminal.watch": async (args: unknown, ctx: ActionContext, focusedAtDispatch: string | null) => {
    const { terminalId } = (args as { terminalId?: string } | undefined) ?? {};
    // Binds on the argument, not `ctx.focusedTerminalId`. A pinned help
    // session's context snapshot is ambient state captured at provision time,
    // not the caller naming a target, and unpinned external dispatch has no
    // snapshot at all — it falls straight through to live focus.
    requireExplicitTerminalIdForAgentDispatch("terminal.watch", terminalId, ctx);
    const state = usePanelStore.getState();
    const targetId = terminalId ?? ctx.focusedTerminalId ?? focusedAtDispatch;
    if (!targetId) return;

    if (state.watchedPanels.has(targetId)) {
      state.unwatchPanel(targetId);
    } else {
      const terminal = state.panelsById[targetId];
      const agentState = terminal && isPtyPanel(terminal) ? terminal.agentState : undefined;
      if (agentState === "completed" || agentState === "waiting" || agentState === "exited") {
        fireWatchNotification(targetId, terminal?.title ?? targetId, agentState);
      } else {
        state.watchPanel(targetId);
      }
    }
  },
} satisfies Record<
  string,
  (args: unknown, ctx: ActionContext, focusedAtDispatch: string | null) => Promise<unknown>
>;

export type TerminalLifecycleActionRunId = keyof typeof terminalLifecycleActionRuns;
