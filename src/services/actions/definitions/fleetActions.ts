import { z } from "zod";
import type { ActionRegistry } from "../actionTypes";
import { usePanelStore } from "@/store/panelStore";
import {
  useFleetArmingStore,
  isFleetArmEligible,
  isFleetInterruptAgentEligible,
  isFleetRestartAgentEligible,
  isFleetWaitingAgentEligible,
  collectEligibleIds,
  computeArmByStateIds,
  type FleetArmStatePreset,
} from "@/store/fleetArmingStore";
import { useFleetFailureStore } from "@/store/fleetFailureStore";
import {
  useFleetPendingActionStore,
  type FleetPendingActionKind,
} from "@/store/fleetPendingActionStore";
import { useFleetScopeFlagStore } from "@/store/fleetScopeFlagStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useProjectStore } from "@/store/projectStore";
import { useProjectSettingsStore } from "@/store/projectSettingsStore";
import { projectClient, terminalClient } from "@/clients";
import { broadcastFleetLiteralPaste } from "@/components/Fleet/fleetExecution";
import { notify } from "@/lib/notify";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import type { FleetSavedScope, TerminalInstance } from "@shared/types";

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

  actions.set("fleet.saveNamedFleet", () => ({
    id: "fleet.saveNamedFleet",
    title: "Fleet: Save named fleet",
    description:
      "Persist the current fleet selection (snapshot) or a state filter (predicate) under a name for later recall.",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: saveNamedFleetSchema,
    run: async (args: unknown) => {
      const parsed = saveNamedFleetSchema.parse(args);
      const name = parsed.name.trim();
      if (name.length === 0) return;
      const projectId = useProjectStore.getState().currentProject?.id ?? null;
      if (!projectId) return;
      // Capture the snapshot's terminal IDs BEFORE the IPC round-trip so a
      // user changing the armed set during the await doesn't end up saving a
      // different selection than the one they clicked Save on.
      const newScope = buildSavedScope(parsed);
      if (!newScope) return;
      try {
        const current = await projectClient.getSettings(projectId);
        if (useProjectStore.getState().currentProject?.id !== projectId) return;
        const next: FleetSavedScope[] = [...(current.fleetSavedScopes ?? []), newScope];
        const nextSettings = { ...current, fleetSavedScopes: next };
        await projectClient.saveSettings(projectId, nextSettings);
        if (useProjectStore.getState().currentProject?.id !== projectId) return;
        // Write-through: the SavedFleetsSection reads from useProjectSettingsStore,
        // so the row only appears if the in-memory cache is updated. Without
        // this the user clicks Save, the disk write succeeds, but no row shows.
        if (useProjectSettingsStore.getState().projectId === projectId) {
          useProjectSettingsStore.getState().setSettings(nextSettings);
        }
        notify({
          type: "success",
          message: `Saved fleet "${newScope.name}"`,
          priority: "low",
        });
      } catch (error) {
        notify({
          type: "error",
          title: "Couldn't save fleet",
          message: formatErrorMessage(error, "Couldn't save the fleet to project settings"),
          duration: 5000,
        });
      }
    },
  }));

  actions.set("fleet.recallNamedFleet", () => ({
    id: "fleet.recallNamedFleet",
    title: "Fleet: Recall named fleet",
    description:
      "Apply panes from a saved fleet. Snapshots drop missing IDs; predicates re-evaluate against current panes.",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: idArgSchema,
    run: async (args: unknown) => {
      const { id } = idArgSchema.parse(args);
      const projectId = useProjectStore.getState().currentProject?.id ?? null;
      if (!projectId) return;
      try {
        const current = await projectClient.getSettings(projectId);
        if (useProjectStore.getState().currentProject?.id !== projectId) return;
        const scope = (current.fleetSavedScopes ?? []).find((s) => s.id === id);
        if (!scope) return;
        applySavedScope(scope);
      } catch (error) {
        notify({
          type: "error",
          title: "Couldn't recall fleet",
          message: formatErrorMessage(error, "Couldn't read project settings to recall the fleet"),
          duration: 5000,
        });
      }
    },
  }));

  actions.set("fleet.deleteNamedFleet", () => ({
    id: "fleet.deleteNamedFleet",
    title: "Fleet: Delete named fleet",
    description: "Remove a saved fleet by id. Idempotent — unknown ids are silently ignored.",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: idArgSchema,
    run: async (args: unknown) => {
      const { id } = idArgSchema.parse(args);
      const projectId = useProjectStore.getState().currentProject?.id ?? null;
      if (!projectId) return;
      try {
        const current = await projectClient.getSettings(projectId);
        if (useProjectStore.getState().currentProject?.id !== projectId) return;
        const existing = current.fleetSavedScopes ?? [];
        const next = existing.filter((s) => s.id !== id);
        if (next.length === existing.length) return;
        const nextSettings = { ...current, fleetSavedScopes: next };
        await projectClient.saveSettings(projectId, nextSettings);
        if (useProjectStore.getState().currentProject?.id !== projectId) return;
        if (useProjectSettingsStore.getState().projectId === projectId) {
          useProjectSettingsStore.getState().setSettings(nextSettings);
        }
      } catch (error) {
        notify({
          type: "error",
          title: "Couldn't delete fleet",
          message: formatErrorMessage(error, "Couldn't update project settings"),
          duration: 5000,
        });
      }
    },
  }));
}

const saveNamedFleetSchema = z.object({ name: z.string().min(1) }).and(
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("snapshot"),
      terminalIds: z.array(z.string()).optional(),
    }),
    z.object({
      kind: z.literal("predicate"),
      scope: z.enum(["current", "all"]),
      stateFilter: z.enum(["all", "working", "waiting", "finished"]),
    }),
  ])
);

const idArgSchema = z.object({ id: z.string().min(1) });

type SaveNamedFleetArgs = z.infer<typeof saveNamedFleetSchema>;

/**
 * Build the persisted scope object. For snapshots without an explicit terminalIds
 * argument, we read armOrder live so the UI doesn't have to pass IDs around — but
 * if the caller did pass an empty array on purpose we still honor it (zero-pane
 * snapshot is allowed; recall will arm nothing).
 */
function buildSavedScope(args: SaveNamedFleetArgs): FleetSavedScope | null {
  const id = generateScopeId();
  const createdAt = Date.now();
  const name = args.name.trim();
  if (args.kind === "snapshot") {
    const terminalIds =
      args.terminalIds !== undefined
        ? [...args.terminalIds]
        : [...useFleetArmingStore.getState().armOrder];
    return { kind: "snapshot", id, name, terminalIds, createdAt };
  }
  return {
    kind: "predicate",
    id,
    name,
    scope: args.scope,
    stateFilter: args.stateFilter,
    createdAt,
  };
}

function applySavedScope(scope: FleetSavedScope): void {
  const fleet = useFleetArmingStore.getState();
  if (scope.kind === "snapshot") {
    const { panelsById } = usePanelStore.getState();
    const validIds: string[] = [];
    const ids = Array.isArray(scope.terminalIds) ? scope.terminalIds : [];
    for (const id of ids) {
      if (isFleetArmEligible(panelsById[id])) validIds.push(id);
    }
    fleet.armIds(validIds);
    return;
  }
  if (scope.stateFilter === "all") {
    fleet.armAll(scope.scope);
    return;
  }
  fleet.armByState(scope.stateFilter as FleetArmStatePreset, scope.scope, false);
}

function generateScopeId(): string {
  return crypto.randomUUID();
}

/**
 * Compute how many panes a saved scope would currently arm. Used by the UI to
 * render live counts on saved-fleet rows. Predicate scopes re-evaluate against
 * the current panel state; snapshot scopes return the count of still-eligible
 * stored IDs (silent drop semantics).
 */
export function computeSavedScopePaneCount(scope: FleetSavedScope): number {
  if (scope.kind === "snapshot") {
    const { panelsById } = usePanelStore.getState();
    const ids = Array.isArray(scope.terminalIds) ? scope.terminalIds : [];
    let n = 0;
    for (const id of ids) {
      if (isFleetArmEligible(panelsById[id])) n++;
    }
    return n;
  }
  const activeWorktreeId = useWorktreeSelectionStore.getState().activeWorktreeId ?? null;
  if (scope.stateFilter === "all") {
    return collectEligibleIds(scope.scope, activeWorktreeId).length;
  }
  return computeArmByStateIds(
    scope.stateFilter as FleetArmStatePreset,
    scope.scope,
    activeWorktreeId
  ).length;
}
