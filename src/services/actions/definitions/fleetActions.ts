import { z } from "zod";
import type { ActionRegistry } from "../actionTypes";
import { usePanelStore } from "@/store/panelStore";
import {
  useFleetArmingStore,
  isFleetArmEligible,
  isFleetInterruptAgentEligible,
  isFleetRestartAgentEligible,
  isFleetWaitingAgentEligible,
} from "@/store/fleetArmingStore";
import { useFleetFailureStore } from "@/store/fleetFailureStore";
import {
  useFleetPendingActionStore,
  type FleetPendingActionKind,
} from "@/store/fleetPendingActionStore";
import { useFleetScopeFlagStore } from "@/store/fleetScopeFlagStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { terminalClient } from "@/clients";
import { broadcastFleetLiteralPaste } from "@/components/Fleet/fleetExecution";
import type { TerminalInstance } from "@shared/types";

interface ArmedSnapshot {
  terminalTargets: TerminalInstance[];
  waitingAgentTargets: TerminalInstance[];
  interruptAgentTargets: TerminalInstance[];
  restartAgentTargets: TerminalInstance[];
}

/**
 * Snapshot of the armed fleet at dispatch time. Exited/trashed/backgrounded
 * terminals are silently dropped — the armed set can drift while the user
 * composes it. Always re-read `useFleetArmingStore.getState()` and
 * `usePanelStore.getState()` inside action run() bodies (not in a closure
 * captured above) so the filter reflects state at execution, not bind time.
 */
function snapshotArmed(): ArmedSnapshot {
  const armedIds = useFleetArmingStore.getState().armedIds;
  const terminalTargets: TerminalInstance[] = [];
  const waitingAgentTargets: TerminalInstance[] = [];
  const interruptAgentTargets: TerminalInstance[] = [];
  const restartAgentTargets: TerminalInstance[] = [];
  if (armedIds.size === 0) {
    return { terminalTargets, waitingAgentTargets, interruptAgentTargets, restartAgentTargets };
  }
  const { panelsById } = usePanelStore.getState();
  for (const id of armedIds) {
    const t = panelsById[id];
    if (!isFleetArmEligible(t)) continue;
    terminalTargets.push(t);
    if (isFleetWaitingAgentEligible(t)) waitingAgentTargets.push(t);
    if (isFleetInterruptAgentEligible(t)) interruptAgentTargets.push(t);
    if (isFleetRestartAgentEligible(t)) restartAgentTargets.push(t);
  }
  return { terminalTargets, waitingAgentTargets, interruptAgentTargets, restartAgentTargets };
}

const confirmedArgsSchema = z.object({ confirmed: z.boolean().optional() }).optional();

function parseConfirmed(args: unknown): boolean {
  if (!args || typeof args !== "object") return false;
  const { confirmed } = args as { confirmed?: unknown };
  return confirmed === true;
}

function countSessionLoss(targets: TerminalInstance[]): number {
  return targets.filter((t) => Boolean(t.agentSessionId)).length;
}

function requestConfirmation(kind: FleetPendingActionKind, targets: TerminalInstance[]): void {
  useFleetPendingActionStore.getState().request({
    kind,
    targetCount: targets.length,
    sessionLossCount: countSessionLoss(targets),
  });
}

function clearPendingIf(kind: FleetPendingActionKind): void {
  const pending = useFleetPendingActionStore.getState().pending;
  if (pending && pending.kind === kind) {
    useFleetPendingActionStore.getState().clear();
  }
}

export function registerFleetActions(actions: ActionRegistry): void {
  actions.set("fleet.accept", () => ({
    id: "fleet.accept",
    title: "Fleet: Accept",
    description:
      "Send 'y' + Enter to every armed agent that is waiting for input (accepts [y/N] prompts)",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      const snap = snapshotArmed();
      if (snap.waitingAgentTargets.length === 0) return;
      await Promise.allSettled(
        snap.waitingAgentTargets.map((t) => {
          try {
            // Write literal "y\r" so CLI prompts like "Continue? [y/N]"
            // receive an explicit affirmative rather than the default.
            terminalClient.write(t.id, "y\r");
            return Promise.resolve();
          } catch (error) {
            return Promise.reject(error);
          }
        })
      );
    },
  }));

  actions.set("fleet.reject", () => ({
    id: "fleet.reject",
    title: "Fleet: Reject",
    description:
      "Send 'n' + Enter to every armed agent that is waiting for input (rejects [y/N] prompts; confirms when 5+ targets)",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: confirmedArgsSchema,
    run: async (args: unknown) => {
      // fleet.reject shares Cmd+N with panel.palette and wins on priority.
      // When nothing is armed — or the armed set has no waiting agent to
      // reject — we fall through so the global shortcut still opens the
      // palette; otherwise this hotkey would silently swallow Cmd+N.
      const snap = snapshotArmed();
      if (snap.waitingAgentTargets.length === 0) {
        const { actionService } = await import("@/services/ActionService");
        await actionService.dispatch("panel.palette", undefined, { source: "keybinding" });
        return;
      }
      const confirmed = parseConfirmed(args);
      if (!confirmed && snap.waitingAgentTargets.length >= 5) {
        useFleetPendingActionStore.getState().request({
          kind: "reject",
          targetCount: snap.waitingAgentTargets.length,
          sessionLossCount: countSessionLoss(snap.waitingAgentTargets),
        });
        return;
      }
      clearPendingIf("reject");
      await Promise.allSettled(
        snap.waitingAgentTargets.map((t) => {
          try {
            terminalClient.write(t.id, "n\r");
            return Promise.resolve();
          } catch (error) {
            return Promise.reject(error);
          }
        })
      );
    },
  }));

  actions.set("fleet.interrupt", () => ({
    id: "fleet.interrupt",
    title: "Fleet: Interrupt",
    description:
      "Send double-Escape to armed working/waiting full agent terminals. Confirms when 3+ targets.",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: confirmedArgsSchema,
    run: async (args: unknown) => {
      const snap = snapshotArmed();
      // Double-Escape is only meaningful for agents that are actually
      // mid-work — completed/exited/idle get filtered out at dispatch.
      const targets = snap.interruptAgentTargets;
      if (targets.length === 0) return;
      const confirmed = parseConfirmed(args);
      if (!confirmed && targets.length >= 3) {
        useFleetPendingActionStore.getState().request({
          kind: "interrupt",
          targetCount: targets.length,
          sessionLossCount: countSessionLoss(targets),
        });
        return;
      }
      clearPendingIf("interrupt");
      terminalClient.batchDoubleEscape(targets.map((t) => t.id));
    },
  }));

  actions.set("fleet.restart", () => ({
    id: "fleet.restart",
    title: "Fleet: Restart",
    description: "Restart every armed agent terminal (always requires confirmation)",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: confirmedArgsSchema,
    run: async (args: unknown) => {
      const snap = snapshotArmed();
      const targets = snap.restartAgentTargets;
      if (targets.length === 0) return;
      const confirmed = parseConfirmed(args);
      if (!confirmed) {
        requestConfirmation("restart", targets);
        return;
      }
      clearPendingIf("restart");
      const ids = new Set(targets.map((t) => t.id));
      await usePanelStore.getState().bulkRestartSet(ids);
    },
  }));

  actions.set("fleet.kill", () => ({
    id: "fleet.kill",
    title: "Fleet: Kill",
    description:
      "Remove every armed terminal panel (matches terminal.killAll semantics — not a raw SIGKILL; always requires confirmation)",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: confirmedArgsSchema,
    run: async (args: unknown) => {
      const snap = snapshotArmed();
      const targets = snap.terminalTargets;
      if (targets.length === 0) return;
      const confirmed = parseConfirmed(args);
      if (!confirmed) {
        requestConfirmation("kill", targets);
        return;
      }
      clearPendingIf("kill");
      const ids = new Set(targets.map((t) => t.id));
      usePanelStore.getState().bulkKillSet(ids);
      useFleetArmingStore.getState().clear();
    },
  }));

  actions.set("fleet.trash", () => ({
    id: "fleet.trash",
    title: "Fleet: Trash",
    description: "Move every armed terminal to trash (confirms when 5+ targets)",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: confirmedArgsSchema,
    run: async (args: unknown) => {
      const snap = snapshotArmed();
      const targets = snap.terminalTargets;
      if (targets.length === 0) return;
      const confirmed = parseConfirmed(args);
      if (!confirmed && targets.length >= 5) {
        requestConfirmation("trash", targets);
        return;
      }
      clearPendingIf("trash");
      const ids = new Set(targets.map((t) => t.id));
      usePanelStore.getState().bulkTrashSet(ids);
      useFleetArmingStore.getState().clear();
    },
  }));

  actions.set("fleet.scope.enter", () => ({
    id: "fleet.scope.enter",
    title: "Fleet: Enter Scope Mode",
    description:
      "Activate Fleet scope mode (primitive — gated by fleetScopeMode flag; no-op in legacy mode)",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      const flag = useFleetScopeFlagStore.getState();
      if (!flag.isHydrated || flag.mode !== "scoped") return;
      useWorktreeSelectionStore.getState().enterFleetScope();
    },
  }));

  actions.set("fleet.scope.exit", () => ({
    id: "fleet.scope.exit",
    title: "Fleet: Exit Scope Mode",
    description:
      "Exit Fleet scope mode, restoring the pre-scope active worktree (no-op in legacy mode)",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      const flag = useFleetScopeFlagStore.getState();
      if (!flag.isHydrated || flag.mode !== "scoped") return;
      useWorktreeSelectionStore.getState().exitFleetScope();
    },
  }));

  actions.set("fleet.retryFailures", () => ({
    id: "fleet.retryFailures",
    title: "Fleet: Retry failed broadcast",
    description:
      "Re-fire the most recent broadcast against any panes that rejected it. No-op when no failures are recorded.",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      const { failedIds, payload } = useFleetFailureStore.getState();
      if (payload == null || failedIds.size === 0) return;
      // Snapshot once — `failedIds` mutates as dismissId fires inside the loop.
      const targets = Array.from(failedIds);
      const result = await broadcastFleetLiteralPaste(payload, targets);
      const stillFailed = new Set(result.failedIds);
      for (const id of targets) {
        if (!stillFailed.has(id)) useFleetFailureStore.getState().dismissId(id);
      }
    },
  }));

  actions.set("fleet.armMatchingFilter", () => ({
    id: "fleet.armMatchingFilter",
    title: "Fleet: Arm Terminals Matching Filter",
    description:
      "Arm all eligible terminals whose worktree is in the provided set — sidebar 'Arm N matching' affordance",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ worktreeIds: z.array(z.string()) }),
    run: async (args: unknown) => {
      const worktreeIds = (args as { worktreeIds?: string[] } | undefined)?.worktreeIds ?? [];
      useFleetArmingStore.getState().armMatchingFilter(worktreeIds);
    },
  }));

  actions.set("fleet.armFocused", () => ({
    id: "fleet.armFocused",
    title: "Fleet: Toggle Arm Focused Pane",
    description:
      "Toggle fleet membership on the focused terminal — keyboard equivalent of ⌘/⇧-clicking pane chrome",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      const focusedId = usePanelStore.getState().focusedId;
      if (!focusedId) return;
      const terminal = usePanelStore.getState().panelsById[focusedId];
      // Match the mouse-path eligibility gate so chord and click behave
      // identically: trashed/backgrounded/no-PTY panes can't enter the
      // fleet from either entry point.
      if (!isFleetArmEligible(terminal)) return;
      useFleetArmingStore.getState().toggleId(focusedId);
    },
  }));
}
