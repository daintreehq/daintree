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
import { useFleetRunStore, summarizeFleetRun } from "@/store/fleetRunStore";
import {
  useFleetPendingActionStore,
  type FleetPendingActionKind,
} from "@/store/fleetPendingActionStore";
import { useFleetScopeFlagStore } from "@/store/fleetScopeFlagStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useProjectStore } from "@/store/projectStore";
import { useProjectSettingsStore } from "@/store/projectSettingsStore";
import { projectClient, terminalClient } from "@/clients";
import { filterEligibleIds } from "@/components/Fleet/fleetExecution";
import { runManagedFleetBroadcast } from "@/components/Fleet/fleetEnterBroadcast";
import { getNarrowPanel } from "@/store/slices/panelRegistry/selectors";
import { notify } from "@/lib/notify";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import type { FleetSavedScope, ProjectSettings } from "@shared/types";
import { isPtyPanel, type PtyPanelData } from "@shared/types/panel";

const FLEET_USAGE_HISTORY_CAP = 20;

interface ArmedSnapshot {
  terminalTargets: PtyPanelData[];
  waitingAgentTargets: PtyPanelData[];
  interruptAgentTargets: PtyPanelData[];
  restartAgentTargets: PtyPanelData[];
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
  const terminalTargets: PtyPanelData[] = [];
  const waitingAgentTargets: PtyPanelData[] = [];
  const interruptAgentTargets: PtyPanelData[] = [];
  const restartAgentTargets: PtyPanelData[] = [];
  if (armedIds.size === 0) {
    return { terminalTargets, waitingAgentTargets, interruptAgentTargets, restartAgentTargets };
  }
  const { panelsById } = usePanelStore.getState();
  for (const id of armedIds) {
    const t = getNarrowPanel(panelsById, id);
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

function countSessionLoss(targets: PtyPanelData[]): number {
  return targets.filter((t) => Boolean(t.agentSessionId)).length;
}

function requestConfirmation(kind: FleetPendingActionKind, targets: PtyPanelData[]): void {
  useFleetPendingActionStore.getState().request({
    kind,
    targetCount: targets.length,
    sessionLossCount: countSessionLoss(targets),
  });
}

/**
 * Module-level re-entrancy flag for `fleet.retryFailures`. A fast double-
 * click on the banner's "Retry failed" button would otherwise dispatch
 * two concurrent broadcasts against the same target set; for payloads
 * ending in `\r` that double-executes the command in every pane.
 */
let retryInFlight = false;

function clearPendingIf(kind: FleetPendingActionKind): void {
  const pending = useFleetPendingActionStore.getState().pending;
  if (pending && pending.kind === kind) {
    useFleetPendingActionStore.getState().clear();
  }
}

export function registerFleetActions(actions: ActionRegistry): void {
  actions.set("fleet.accept", () => ({
    id: "fleet.accept",
    // Armed-fleet hotkey actions operate on the live armed/waiting snapshot and
    // no-op when nothing is armed. They're keybinding/Fleet-UI driven, not
    // palette commands.
    palette: { mode: "hidden" },
    title: "Fleet: Accept",
    description:
      "Send 'y' + Enter to every armed agent that is waiting for input (accepts [y/N] prompts)",
    category: "terminal",
    kind: "command",
    danger: "safe",
    // Injects keystrokes into agent terminals — closed to plugin dispatch so it
    // can't be an end-run around the `agent:input` capability (#10558).
    denyPluginDispatch: true,
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
    palette: { mode: "hidden" },
    title: "Fleet: Reject",
    description:
      "Send 'n' + Enter to every armed agent that is waiting for input (rejects [y/N] prompts; confirms when 5+ targets)",
    category: "terminal",
    kind: "command",
    danger: "safe",
    // Injects keystrokes into agent terminals — closed to plugin dispatch (#10558).
    denyPluginDispatch: true,
    scope: "renderer",
    argsSchema: confirmedArgsSchema,
    run: async (args: unknown) => {
      const snap = snapshotArmed();
      if (snap.waitingAgentTargets.length === 0) return;
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
    palette: { mode: "hidden" },
    title: "Fleet: Interrupt",
    description:
      "Send double-Escape to armed working/waiting full agent terminals. Confirms when 3+ targets.",
    category: "terminal",
    kind: "command",
    danger: "safe",
    // Injects control keystrokes into agent terminals — closed to plugin dispatch (#10558).
    denyPluginDispatch: true,
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
    palette: { mode: "hidden" },
    title: "Fleet: Restart",
    description: "Restart every armed agent terminal (always requires confirmation)",
    category: "terminal",
    kind: "command",
    danger: "confirm",
    scope: "renderer",
    dangerRationale:
      "Restarts every armed agent terminal. All scrollback and session state are lost.",
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
    palette: { mode: "hidden" },
    title: "Fleet: Kill",
    description:
      "Remove every armed terminal panel. This destroys those terminals with no trash step: their running processes and scrollback are unrecoverable, though a journaled agent session can still be resumed afterwards. It always requires confirmation.",
    category: "terminal",
    kind: "command",
    danger: "confirm",
    scope: "renderer",
    dangerRationale:
      "Removes every armed terminal panel. All scrollback and session state are lost.",
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
    palette: { mode: "hidden" },
    title: "Fleet: Trash",
    description: "Move every armed terminal to trash (confirms when 5+ targets)",
    category: "terminal",
    kind: "command",
    danger: "confirm",
    scope: "renderer",
    dangerRationale:
      "Moves every armed terminal to trash. Scrollback is lost for each trashed terminal.",
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
    palette: { mode: "hidden" },
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
    palette: { mode: "hidden" },
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
      // Read the live token synchronously at dispatch time and pass it
      // through. `exitFleetScope` re-validates it against the store before any
      // async work, so a scope torn down between this read and the call is a
      // structural no-op rather than a misfired restore.
      const token = useWorktreeSelectionStore.getState()._fleetScopeToken;
      if (token === null) return;
      useWorktreeSelectionStore.getState().exitFleetScope(token);
    },
  }));

  actions.set("fleet.retryFailures", () => ({
    id: "fleet.retryFailures",
    palette: { mode: "hidden" },
    title: "Fleet: Retry failed broadcast",
    description:
      "Re-fire the most recent broadcast against any panes that rejected it. No-op when no failures are recorded.",
    category: "terminal",
    kind: "command",
    danger: "safe",
    // Re-broadcasts the last (arbitrary, often \r-terminated) payload into
    // terminals — closed to plugin dispatch so it can't inject commands (#10558).
    denyPluginDispatch: true,
    scope: "renderer",
    run: async () => {
      // Re-entrancy guard: a fast double-click on "Retry failed" would
      // otherwise dispatch two concurrent broadcasts against the same
      // target set before either's dismissId loop runs — for command-
      // terminating payloads (`"make deploy\r"`) that double-executes
      // the command.
      if (retryInFlight) return;
      const { failedIds, payload } = useFleetFailureStore.getState();
      if (payload == null || failedIds.size === 0) return;
      // Snapshot once — `failedIds` mutates as dismissId fires inside the loop.
      const targets = Array.from(failedIds);
      // Re-check eligibility at dispatch time: a pane that died or was trashed
      // since the failure was recorded must not receive bytes. The primary
      // broadcast gates this in its caller (tryFleetBroadcastFromEditor), not
      // inside executeFleetBroadcast — so the retry path owns the filter too.
      const eligibleTargets = filterEligibleIds(targets);
      if (eligibleTargets.length === 0) return;
      retryInFlight = true;
      try {
        // The stored payload is already fully substituted (it's the verbatim
        // literal the user originally broadcast), so route it through
        // perTargetOverrides to bypass executeFleetBroadcast's recipe-variable
        // substitution — the empty draft is never resolved when every target
        // has an override. `runManagedFleetBroadcast` runs it through the shared
        // single-flight controller so the retry gains batching, progress, and a
        // working ribbon Cancel button just like the primary Enter path.
        const perTargetOverrides = Object.fromEntries(eligibleTargets.map((id) => [id, payload]));
        const result = await runManagedFleetBroadcast("", eligibleTargets, perTargetOverrides, {
          isRetry: true,
          draftPreview: payload,
        });
        // Permanent failures (dead PTYs) auto-disarm so a future retry doesn't
        // keep firing into the same dead pipes. The retry chip clears for them
        // too — the user already saw them once; surfacing the same id again
        // after we've stopped including it in broadcasts would be noise.
        if (result.permanentlyFailedIds.length > 0) {
          const arming = useFleetArmingStore.getState();
          for (const id of result.permanentlyFailedIds) {
            arming.disarmId(id);
            useFleetFailureStore.getState().dismissId(id);
          }
        }
        const stillFailed = new Set(result.transientlyFailedIds);
        for (const id of targets) {
          if (!stillFailed.has(id)) useFleetFailureStore.getState().dismissId(id);
        }
      } finally {
        retryInFlight = false;
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
    palette: { mode: "hidden" },
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
      const terminal = getNarrowPanel(usePanelStore.getState().panelsById, focusedId);
      if (!isFleetArmEligible(terminal)) return;
      useFleetArmingStore.getState().toggleId(focusedId);
    },
  }));

  actions.set("fleet.armAll", () => ({
    id: "fleet.armAll",
    title: "Fleet: Arm All Eligible",
    description: "Arm all fleet-eligible terminals in the current worktree",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z
      .object({
        scope: z.enum(["current", "all"]).optional().default("current"),
      })
      .optional(),
    run: async (args: unknown) => {
      const { scope } = (args as { scope?: "current" | "all" }) ?? {};
      useFleetArmingStore.getState().armAll(scope ?? "current");
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
        // Capture the pre-append snapshot so a failed save can roll the
        // in-memory append back — otherwise the dropdown would show a
        // phantom fleet the user can't recall across restarts.
        const previousSettings =
          useProjectSettingsStore.getState().projectId === projectId
            ? useProjectSettingsStore.getState().settings
            : null;
        // Append atomically against the in-memory store so a near-simultaneous
        // recall's lastUsedAt stamp is not clobbered. The naive
        // getSettings-read-then-save pattern dropped concurrent stamps when
        // recall's fire-and-forget save landed after our await. Falls back to
        // an IPC read only when the in-memory store hasn't been hydrated for
        // this project (cold-start case).
        const nextSettings = await appendFleetScopeInMemory(projectId, newScope);
        if (useProjectStore.getState().currentProject?.id !== projectId) return;
        try {
          await projectClient.saveSettings(projectId, nextSettings);
        } catch (saveError) {
          // Roll back the in-memory append so the user doesn't see a row
          // that won't be on disk after a reload.
          if (previousSettings && useProjectSettingsStore.getState().projectId === projectId) {
            useProjectSettingsStore.setState({ settings: previousSettings });
          }
          throw saveError;
        }
        // In-memory was already updated by `appendFleetScopeInMemory` (which
        // also runs the detectedRunners filter inside `setSettings`). Do NOT
        // call `setSettings(nextSettings)` here — that would overwrite a
        // concurrent recall's stamp that landed on the in-memory store
        // between the append and the await above.
        notify({
          type: "success",
          message: `Saved fleet "${newScope.name}"`,
          priority: "low",
        });
      } catch (error) {
        // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
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
        // Read the scope from the in-memory store first so two near-simultaneous
        // recalls see a consistent snapshot, and so the subsequent stamp lands
        // on a write that the concurrent caller can't have clobbered before
        // reading. Falls back to a one-shot IPC read on cold start.
        const scope = await findFleetScope(projectId, id);
        if (!scope) return;
        applySavedScope(scope);

        const now = Date.now();
        stampFleetUsageInMemory(projectId, id, now);
      } catch (error) {
        // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
        notify({
          type: "error",
          title: "Couldn't recall fleet",
          message: formatErrorMessage(error, "Couldn't read project settings to recall the fleet"),
          duration: 5000,
        });
      }
    },
  }));

  actions.set("fleet.getRunStatus", () => ({
    id: "fleet.getRunStatus",
    // Query with a structured result — nothing for a palette pick to show.
    palette: { mode: "hidden" },
    title: "Fleet: Get run status",
    description:
      "Read a snapshot of the in-app fleet broadcast the user is currently running, including per-terminal delivery and liveness. This only observes — it dispatches nothing, so driving a fan-out means sending to each terminal yourself and watching them with a status snapshot or batched wait. Agent state here is a passive heuristic and any parsed check result is not a process exit code, so confirm both before acting on them.",
    category: "terminal",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    resultSchema: fleetRunStatusResultSchema,
    mcpOutputSchema: true,
    mcpAnnotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
    },
    run: async () => {
      const run = useFleetRunStore.getState().run;
      const armedCount = useFleetArmingStore.getState().armedIds.size;
      if (run === null) return { run: null, armedCount };
      const { panelsById } = usePanelStore.getState();
      return {
        run: {
          runId: run.runId,
          status: run.status,
          isRetry: run.isRetry,
          draftPreview: run.draftPreview,
          startedAt: run.startedAt,
          endedAt: run.endedAt,
          counts: summarizeFleetRun(run),
          targets: run.targets.map((t) => {
            // lastCheckResult is read live from the panel registry rather than
            // snapshotted into the run store — panels remain the single source
            // of terminal truth; the run store only owns run lifecycle fields.
            const panel = getNarrowPanel(panelsById, t.terminalId);
            return {
              terminalId: t.terminalId,
              title: t.title,
              worktreeId: t.worktreeId,
              submission: t.submission,
              failureKind: t.failureKind,
              failureReason: t.failureReason,
              agentState: t.agentState,
              waitingReason: t.waitingReason,
              exitCode: t.exitCode ?? null,
              settled: t.settled,
              gone: t.gone,
              lastCheckResult: panel && isPtyPanel(panel) ? panel.lastCheckResult : undefined,
            };
          }),
        },
        armedCount,
      };
    },
  }));

  actions.set("fleet.deleteNamedFleet", () => ({
    id: "fleet.deleteNamedFleet",
    title: "Fleet: Delete named fleet",
    description: "Remove a saved fleet by id. Idempotent — unknown ids are silently ignored.",
    category: "terminal",
    kind: "command",
    danger: "confirm",
    scope: "renderer",
    dangerRationale:
      "Permanently deletes a saved fleet. The named fleet configuration cannot be recovered.",
    argsSchema: idArgSchema,
    run: async (args: unknown) => {
      const { id } = idArgSchema.parse(args);
      const projectId = useProjectStore.getState().currentProject?.id ?? null;
      if (!projectId) return;
      try {
        const settingsState = useProjectSettingsStore.getState();
        const inMemory = settingsState.projectId === projectId ? settingsState.settings : null;
        const inMemoryScopes = inMemory?.fleetSavedScopes ?? [];
        if (inMemory && inMemoryScopes.some((s) => s.id === id)) {
          // Optimistic path: the scope is present in the hydrated store (the
          // dropdown that triggers delete is rendered from it). Remove it in
          // memory first, persist in the background, roll back on failure.
          const previousSettings = inMemory;
          const nextSettings = {
            ...previousSettings,
            fleetSavedScopes: inMemoryScopes.filter((s) => s.id !== id),
          };
          settingsState.setSettings(nextSettings);
          try {
            await projectClient.saveSettings(projectId, nextSettings);
          } catch (saveError) {
            if (useProjectSettingsStore.getState().projectId === projectId) {
              useProjectSettingsStore.setState({ settings: previousSettings });
            }
            throw saveError;
          }
          return;
        }

        // Cold/stale path: store unhydrated, or out of sync with the scope being
        // deleted — read authoritative settings from disk, persist, then hydrate
        // the in-memory store. Mirrors findFleetScope.
        const current = await projectClient.getSettings(projectId);
        if (useProjectStore.getState().currentProject?.id !== projectId) return;
        const existing = current.fleetSavedScopes ?? [];
        const next = existing.filter((s) => s.id !== id);
        if (next.length === existing.length) return;
        const nextSettings = { ...current, fleetSavedScopes: next };
        await projectClient.saveSettings(projectId, nextSettings);
        if (useProjectStore.getState().currentProject?.id !== projectId) return;
        useProjectSettingsStore.setState({ projectId, settings: nextSettings });
      } catch (error) {
        // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
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

// Mirrors `FleetRunTarget` (src/store/fleetRunStore.ts) plus a live-derived
// `lastCheckResult` (same shape as TerminalStatusEntrySchema's — parsed
// check summary, not an exit code). Advertised as the MCP outputSchema.
const fleetRunTargetStatusSchema = z.object({
  terminalId: z.string(),
  title: z.string(),
  worktreeId: z.string().nullable(),
  submission: z.enum(["pending", "sent", "failed", "skipped"]),
  failureKind: z.enum(["permanent", "transient"]).optional(),
  failureReason: z.string().optional(),
  agentState: z.string().nullable(),
  waitingReason: z.string().optional(),
  exitCode: z.number().int().nullable().optional(),
  settled: z.boolean(),
  gone: z.boolean(),
  lastCheckResult: z
    .object({
      command: z.string().nullable(),
      passed: z.boolean(),
      ranAt: z.number(),
      failureSummary: z.string().nullable(),
      truncated: z.boolean(),
    })
    .optional(),
});

const fleetRunStatusResultSchema = z.object({
  run: z
    .object({
      runId: z.string(),
      status: z.enum(["submitting", "watching", "completed", "cancelled", "failed", "superseded"]),
      isRetry: z.boolean(),
      draftPreview: z.string(),
      startedAt: z.number(),
      endedAt: z.number().optional(),
      counts: z.object({
        total: z.number().int(),
        sent: z.number().int(),
        sendFailed: z.number().int(),
        skipped: z.number().int(),
        working: z.number().int(),
        waiting: z.number().int(),
        done: z.number().int(),
      }),
      targets: z.array(fleetRunTargetStatusSchema),
    })
    .nullable(),
  armedCount: z.number().int(),
});

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
      if (isFleetArmEligible(getNarrowPanel(panelsById, id))) validIds.push(id);
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

/**
 * Locate a saved scope in the in-memory project-settings store, falling
 * back to a one-shot IPC read when the store hasn't been hydrated for the
 * active project (cold-start case — the dropdown that triggers recall is
 * itself gated on the store being loaded, so this branch is rare).
 */
async function findFleetScope(projectId: string, scopeId: string): Promise<FleetSavedScope | null> {
  const store = useProjectSettingsStore.getState();
  if (store.projectId === projectId && store.settings) {
    return (store.settings.fleetSavedScopes ?? []).find((s) => s.id === scopeId) ?? null;
  }
  const current = await projectClient.getSettings(projectId);
  if (useProjectStore.getState().currentProject?.id !== projectId) return null;
  // Hydrate the in-memory store so subsequent operations (the stamp below)
  // can use the in-memory path. The project-switch check above guarantees
  // we just fetched the right project's settings, so it's safe to write.
  useProjectSettingsStore.setState({
    projectId,
    settings: current,
  });
  return (current.fleetSavedScopes ?? []).find((s) => s.id === scopeId) ?? null;
}

/**
 * Append a new scope to the in-memory project-settings store atomically,
 * returning the full settings object the caller should persist. Operates
 * on the freshest in-memory snapshot via `setState((state) => ...)` so
 * a concurrent recall's `lastUsedAt` stamp on a different scope is not
 * clobbered. On cold start (in-memory store unhydrated) does an IPC read
 * to fetch the current fleetSavedScopes from disk — this loses the
 * in-memory race guarantee, but the dropdown that triggers the action
 * requires a loaded store to be visible, so in practice this branch is
 * rare. Throws when the project switches mid-IPC; the caller's catch
 * surfaces the error to the user.
 */
async function appendFleetScopeInMemory(
  projectId: string,
  newScope: FleetSavedScope
): Promise<ProjectSettings> {
  const store = useProjectSettingsStore.getState();
  if (store.projectId === projectId && store.settings) {
    let next: ProjectSettings | null = null;
    useProjectSettingsStore.setState((state) => {
      if (!state.settings) return {};
      const merged = [...(state.settings.fleetSavedScopes ?? []), newScope];
      next = { ...state.settings, fleetSavedScopes: merged };
      return { settings: next };
    });
    if (next) return next;
  }
  const current = await projectClient.getSettings(projectId);
  if (useProjectStore.getState().currentProject?.id !== projectId) {
    throw new Error("Project switched mid-IPC");
  }
  const merged = [...(current.fleetSavedScopes ?? []), newScope];
  const nextSettings = { ...current, fleetSavedScopes: merged };
  useProjectSettingsStore.setState({
    projectId,
    settings: nextSettings,
  });
  return nextSettings;
}

/**
 * Stamp `lastUsedAt` and append to `usageHistory` (capped) on a single
 * scope, atomically against the in-memory store. The persist call reads
 * the freshest in-memory snapshot, so any other in-flight append (a
 * concurrent save) is preserved in the persisted history rather than
 * dropped. Persist is fire-and-forget: the in-memory store is the source
 * of truth for the UI, and the next project switch / save reconciles disk.
 */
function stampFleetUsageInMemory(projectId: string, scopeId: string, now: number): void {
  let snapshot: ProjectSettings | null = null;
  useProjectSettingsStore.setState((state) => {
    if (!state.settings || state.projectId !== projectId) return {};
    const nextScopes = (state.settings.fleetSavedScopes ?? []).map((s) => {
      if (s.id !== scopeId) return s;
      return {
        ...s,
        lastUsedAt: now,
        usageHistory: [...(s.usageHistory ?? []), now].slice(-FLEET_USAGE_HISTORY_CAP),
      };
    });
    snapshot = { ...state.settings, fleetSavedScopes: nextScopes };
    return { settings: snapshot };
  });
  if (snapshot) {
    projectClient.saveSettings(projectId, snapshot).catch((err) => {
      console.warn("Failed to persist fleet recency stamp:", err);
    });
  }
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
      if (isFleetArmEligible(getNarrowPanel(panelsById, id))) n++;
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
