import { z } from "zod";
import type { ActionRegistry } from "../actionTypes";
import { usePanelStore } from "@/store/panelStore";
import { useFleetArmingStore, isFleetArmEligible } from "@/store/fleetArmingStore";
import {
  useFleetPendingActionStore,
  type FleetPendingActionKind,
} from "@/store/fleetPendingActionStore";
import { terminalClient } from "@/clients";
import type { TerminalInstance } from "@shared/types";

interface ArmedSnapshot {
  liveTerminals: TerminalInstance[];
  waitingTerminals: TerminalInstance[];
  interruptCandidates: TerminalInstance[];
  sessionLossCount: number;
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
  const liveTerminals: TerminalInstance[] = [];
  const waitingTerminals: TerminalInstance[] = [];
  const interruptCandidates: TerminalInstance[] = [];
  let sessionLossCount = 0;
  if (armedIds.size === 0) {
    return { liveTerminals, waitingTerminals, interruptCandidates, sessionLossCount };
  }
  const { panelsById } = usePanelStore.getState();
  for (const id of armedIds) {
    const t = panelsById[id];
    if (!isFleetArmEligible(t)) continue;
    liveTerminals.push(t);
    if (t.agentState === "waiting") waitingTerminals.push(t);
    // Interrupt only makes sense for agents that are actually doing
    // something — sending ESC ESC to a completed/idle/exited agent is
    // either a no-op or a spurious keystroke.
    if (t.agentState === "working" || t.agentState === "running" || t.agentState === "waiting") {
      interruptCandidates.push(t);
    }
    if (t.agentSessionId) sessionLossCount++;
  }
  return { liveTerminals, waitingTerminals, interruptCandidates, sessionLossCount };
}

const confirmedArgsSchema = z.object({ confirmed: z.boolean().optional() }).optional();

function parseConfirmed(args: unknown): boolean {
  if (!args || typeof args !== "object") return false;
  const { confirmed } = args as { confirmed?: unknown };
  return confirmed === true;
}

function requestConfirmation(kind: FleetPendingActionKind, snapshot: ArmedSnapshot): void {
  useFleetPendingActionStore.getState().request({
    kind,
    targetCount: snapshot.liveTerminals.length,
    sessionLossCount: snapshot.sessionLossCount,
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
      if (snap.waitingTerminals.length === 0) return;
      await Promise.allSettled(
        snap.waitingTerminals.map((t) => {
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
      if (snap.waitingTerminals.length === 0) {
        const { actionService } = await import("@/services/ActionService");
        await actionService.dispatch("panel.palette", undefined, { source: "keybinding" });
        return;
      }
      const confirmed = parseConfirmed(args);
      if (!confirmed && snap.waitingTerminals.length >= 5) {
        useFleetPendingActionStore.getState().request({
          kind: "reject",
          targetCount: snap.waitingTerminals.length,
          sessionLossCount: snap.sessionLossCount,
        });
        return;
      }
      clearPendingIf("reject");
      await Promise.allSettled(
        snap.waitingTerminals.map((t) => {
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
      "Send a double-Escape to armed agents in working/waiting/running state (confirms when 3+ targets; 50ms per-PTY gap scheduled in the PTY host)",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: confirmedArgsSchema,
    run: async (args: unknown) => {
      const snap = snapshotArmed();
      // Double-Escape is only meaningful for agents that are actually
      // mid-work — completed/exited/idle get filtered out at dispatch.
      const targets = snap.interruptCandidates;
      if (targets.length === 0) return;
      const confirmed = parseConfirmed(args);
      if (!confirmed && targets.length >= 3) {
        useFleetPendingActionStore.getState().request({
          kind: "interrupt",
          targetCount: targets.length,
          sessionLossCount: snap.sessionLossCount,
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
      if (snap.liveTerminals.length === 0) return;
      const confirmed = parseConfirmed(args);
      if (!confirmed) {
        requestConfirmation("restart", snap);
        return;
      }
      clearPendingIf("restart");
      const ids = new Set(snap.liveTerminals.map((t) => t.id));
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
      if (snap.liveTerminals.length === 0) return;
      const confirmed = parseConfirmed(args);
      if (!confirmed) {
        requestConfirmation("kill", snap);
        return;
      }
      clearPendingIf("kill");
      const ids = new Set(snap.liveTerminals.map((t) => t.id));
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
      if (snap.liveTerminals.length === 0) return;
      const confirmed = parseConfirmed(args);
      if (!confirmed && snap.liveTerminals.length >= 5) {
        requestConfirmation("trash", snap);
        return;
      }
      clearPendingIf("trash");
      const ids = new Set(snap.liveTerminals.map((t) => t.id));
      usePanelStore.getState().bulkTrashSet(ids);
      useFleetArmingStore.getState().clear();
    },
  }));
}
