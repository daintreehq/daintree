import { z } from "zod";
import type { ActionRegistry } from "../actionTypes";
import { usePanelStore } from "@/store/panelStore";
import {
  useFleetArmingStore,
  isFleetArmEligible,
  collectEligibleIds,
} from "@/store/fleetArmingStore";
import {
  useFleetPendingActionStore,
  type FleetPendingActionKind,
} from "@/store/fleetPendingActionStore";
import { useFleetDeckStore } from "@/store/fleetDeckStore";
import { useFleetSavedScopesStore } from "@/store/fleetSavedScopesStore";
import { useFleetComposerStore } from "@/store/fleetComposerStore";
import { useFleetScopeFlagStore } from "@/store/fleetScopeFlagStore";
import { useProjectStore } from "@/store/projectStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { terminalClient } from "@/clients";
import { executeFleetBroadcast } from "@/components/Fleet/fleetExecution";
import { useNotificationStore } from "@/store/notificationStore";
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
      "Send double-Escape to armed working/waiting/running agents. Confirms when 3+ targets.",
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

  actions.set("fleet.deck.toggle", () => ({
    id: "fleet.deck.toggle",
    title: "Fleet Deck: Toggle",
    description:
      "Open or close the Fleet Deck — a persistent dockable panel with live agent terminal mirrors",
    category: "panel",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      useFleetDeckStore.getState().toggle();
    },
  }));

  actions.set("fleet.deck.open", () => ({
    id: "fleet.deck.open",
    title: "Fleet Deck: Open",
    description: "Open the Fleet Deck panel",
    category: "panel",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      useFleetDeckStore.getState().open();
    },
  }));

  actions.set("fleet.deck.close", () => ({
    id: "fleet.deck.close",
    title: "Fleet Deck: Close",
    description: "Close the Fleet Deck panel",
    category: "panel",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      useFleetDeckStore.getState().close();
    },
  }));

  actions.set("fleet.scope.save", () => ({
    id: "fleet.scope.save",
    title: "Fleet: Save Scope",
    description: "Save the current armed set as a named scope for quick recall",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ name: z.string().min(1) }).optional(),
    run: async (args: unknown) => {
      const projectId = useProjectStore.getState().currentProject?.id;
      if (!projectId) return;
      const armedIds = Array.from(useFleetArmingStore.getState().armedIds);
      if (armedIds.length === 0) return;
      const name = (args as { name?: string } | undefined)?.name ?? prompt("Save scope as:");
      if (!name?.trim()) return;
      await useFleetSavedScopesStore.getState().saveScope(projectId, {
        name: name.trim(),
        terminalIds: armedIds,
      });
    },
  }));

  actions.set("fleet.scope.recall", () => ({
    id: "fleet.scope.recall",
    title: "Fleet: Recall Scope",
    description: "Arm the terminals from a saved scope by name or index",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z
      .object({ scopeId: z.string().optional(), index: z.number().optional() })
      .optional(),
    run: async (args: unknown) => {
      const a = args as { scopeId?: string; index?: number } | undefined;
      const scopes = useFleetSavedScopesStore.getState().scopes;
      let scope = a?.scopeId ? scopes.find((s) => s.id === a.scopeId) : undefined;
      if (!scope && a?.index != null && a.index >= 0 && a.index < scopes.length) {
        scope = scopes[a.index];
      }
      if (!scope) return;
      if (scope.terminalIds && scope.terminalIds.length > 0) {
        useFleetArmingStore.getState().armIds(scope.terminalIds);
        return;
      }
      if (scope.filter) {
        const activeWorktreeId = useWorktreeSelectionStore.getState().activeWorktreeId ?? null;
        const ids = collectEligibleIds(scope.filter.scope as "current" | "all", activeWorktreeId);
        useFleetArmingStore.getState().armIds(ids);
      }
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

  actions.set("fleet.scope.delete", () => ({
    id: "fleet.scope.delete",
    title: "Fleet: Delete Scope",
    description: "Remove a saved scope",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ scopeId: z.string() }).optional(),
    run: async (args: unknown) => {
      const projectId = useProjectStore.getState().currentProject?.id;
      if (!projectId) return;
      const scopeId = (args as { scopeId?: string } | undefined)?.scopeId;
      if (!scopeId) return;
      await useFleetSavedScopesStore.getState().deleteScope(projectId, scopeId);
    },
  }));

  actions.set("fleet.dryRun", () => ({
    id: "fleet.dryRun",
    title: "Fleet: Dry-Run Preview",
    description: "Open dry-run preview showing resolved payload per target before sending",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      const draft = useFleetComposerStore.getState().draft;
      if (draft.trim().length === 0) return;
      useFleetComposerStore.getState().requestDryRun();
    },
  }));

  actions.set("fleet.retryFailed", () => ({
    id: "fleet.retryFailed",
    title: "Fleet: Retry Failed",
    description:
      "Re-arm the terminals that failed in the last broadcast and re-send the last prompt",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      const { lastFailedIds, lastBroadcastPrompt, draft } = useFleetComposerStore.getState();
      if (lastFailedIds.length === 0) return;
      const prompt = draft.trim() || lastBroadcastPrompt;
      if (!prompt) return;
      // Arm the specific terminals that failed, not the current armed set
      useFleetArmingStore.getState().armIds(lastFailedIds);

      const result = await executeFleetBroadcast(prompt, lastFailedIds);
      if (result.failureCount > 0) {
        useFleetComposerStore.getState().setLastFailed(result.failedIds, prompt);
      } else {
        useFleetComposerStore.getState().clearLastFailed();
      }
      useNotificationStore.getState().addNotification({
        type: result.failureCount > 0 ? "warning" : "success",
        priority: "low",
        message:
          result.failureCount > 0
            ? `Retry: ${result.successCount} succeeded, ${result.failureCount} still failing`
            : `Retry: sent to ${result.successCount} agent${result.successCount === 1 ? "" : "s"}`,
      });
    },
  }));
}
