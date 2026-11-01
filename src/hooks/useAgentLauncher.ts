import { useCallback, useEffect, useRef } from "react";
import { usePanelStore, type AddPanelOptions } from "@/store/panelStore";
import { exitProjectHome } from "@/store/storeAccessors";
import type { PanelLimitSnapshot } from "@/store/panelLimitStore";
import type { PtyPanelData, ScheduledRunRef } from "@shared/types/panel";
import { useProjectStore } from "@/store/projectStore";
import { useScratchStore } from "@/store/scratchStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { isMcpSpawnFocusSuppressed } from "@/store/mcpSpawnFocusGuard";
import { useCliAvailabilityStore } from "@/store/cliAvailabilityStore";
import { getNormalizedWorktreeMap } from "./useWorktrees";
import { useWorktreeStoreApi } from "./useWorktreeStore";
import { isElectronAvailable } from "./useElectron";

import { systemClient } from "@/clients";
import { useHomeDir } from "@/hooks/app/useHomeDir";
import { logError, logWarn } from "@/utils/logger";
import { markRendererPerformance } from "@/utils/performance";
import { resolveWorkspaceCwd } from "@/utils/workspaceCwd";
import { readViewDevServerCommand } from "@/utils/devServerCommand";
import { readLaunchPresetSources, waitForLaunchPresets } from "@/utils/presetInventory";
import { notify } from "@/lib/notify";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import { addToWorktreeIndex } from "@/store/slices/panelRegistry/worktreeIndex";
import type {
  AgentSettings,
  CliAvailability,
  TerminalSpawnSource,
  AddPanelFocusPolicy,
} from "@shared/types";
import { isAgentLaunchable } from "@shared/utils/agentAvailability";
import { launchSpawnProvenance } from "@shared/utils/scheduledRunProvenance";
import { findEquivalentMissingCliGate } from "@/utils/missingCliGate";
import { isAssistantFocused } from "@/store/macroFocusStore";
import {
  buildAgentLaunchPlan,
  buildLaunchIdentity,
  findUnloadedLaunchPreset,
  type LaunchAgentIdentity,
} from "@shared/utils/agentLaunchPlan";
import { getAgentConfig, isRegisteredAgent } from "@/config/agents";
import {
  getCurrentLaunchCliDetail,
  resolveAgentLaunchBaseCommand,
} from "@/utils/agentLaunchCommand";
import { resolveAgentLaunchKind } from "@/utils/agentLaunchValidation";
import {
  hostShellDialect,
  isHostMac,
  isHostWindows,
  isRemoteWindow,
  resolveHostTmpDir,
} from "@/hooks/useHostPlatform";
import { agentClipboardDirectory } from "@shared/types/agentSettings";
import { buildFirstPrompt } from "@shared/utils/firstPrompt";

export { resolveAgentLaunchBaseCommand } from "@/utils/agentLaunchCommand";
export { buildLaunchIdentity, type LaunchAgentIdentity };
// Re-exported so the hook stays the canonical import site for launch-path
// callers; the action layer imports the pure module directly (#11547).
export { resolveAgentLaunchKind } from "@/utils/agentLaunchValidation";

/**
 * Resolve the worktree a launch should target. When a `targetWorktreeId` is
 * supplied but matches no known worktree (and the worktree map has finished
 * loading), this throws instead of returning null so the failure surfaces as a
 * real error to callers — notably the MCP `agent.launch` path, where a silent
 * null was serialized as a terminal-less success and triggered client retry
 * loops (#10812). The thrown message lists the available IDs so a model client
 * can self-correct. Before the map is initialized we cannot assert "not found",
 * so we fall through and let the caller use its cwd fallbacks.
 *
 * Only ever reached with an id the caller asked for by name — an inherited
 * ambient selection goes through `resolveLaunchTarget` instead, which must not
 * throw. See that function for why the two are treated differently.
 */
export function resolveLaunchWorktree<T>(
  targetWorktreeId: string | null | undefined,
  worktreeMap: Map<string, T>,
  isInitialized: boolean
): T | null {
  const targetWorktree = targetWorktreeId ? worktreeMap.get(targetWorktreeId) : undefined;
  if (targetWorktreeId && !targetWorktree && isInitialized) {
    throw new Error(
      `Worktree '${targetWorktreeId}' not found. Available worktree IDs: ${
        [...worktreeMap.keys()].join(", ") || "none"
      }`
    );
  }
  return targetWorktree ?? null;
}

/**
 * Pick the worktree a launch actually targets, and the id that describes it.
 *
 * The two sources of a target are not equivalent. An explicit
 * `launchOptions.worktreeId` is the caller naming a destination, so an id that
 * does not resolve is their error and must surface as one (#10812) — it goes
 * straight to `resolveLaunchWorktree` and keeps the throw. An inherited id is
 * whatever the workspace happened to have selected; the user never chose it for
 * this launch. A worktree-less workspace can hold one left behind by a previous
 * project, and failing every launch over it is the bug in #11654 — so once the
 * map is authoritative and the id is absent, the launch simply proceeds without
 * a worktree.
 *
 * Before the map initializes, absent is unknowable rather than false, so an
 * inherited id survives with a null worktree — the panel is still created with
 * it, which is what `buildLaunchIdentity` reports.
 *
 * The id and the worktree are returned together because they must agree: a
 * caller holding the raw inherited id alongside a normalized worktree would tag
 * panels and scope presets to a worktree that does not exist.
 *
 * An explicit `""` normalizes to null rather than travelling as an empty
 * string. Every consumer already reduces it the same way — `|| undefined` for
 * panel options, `|| null` in `buildLaunchIdentity`, a falsy guard in
 * `resolveEffectivePresetId` — so nothing observable changes, and the returned
 * id is then always either a real id or null.
 *
 * `deletedWorktreeIds` carries the ghost rows (#11232): a deleted worktree
 * whose terminals outlived it is absent from the live map but is still a valid
 * active selection — `useActiveWorktreeSync` deliberately holds the selection
 * on one. Dropping it here would land the new panel in the `__none__` bucket
 * (invisible, with a live PTY) instead of alongside the row's surviving
 * terminals, so a ghost id survives the same way a live one does, with a null
 * worktree because it has no path or branch left to report.
 */
export function resolveLaunchTarget<T>(
  explicitWorktreeId: string | undefined,
  inheritedWorktreeId: string | null,
  worktreeMap: Map<string, T>,
  isInitialized: boolean,
  deletedWorktreeIds?: { has: (id: string) => boolean }
): { worktreeId: string | null; worktree: T | null } {
  if (explicitWorktreeId !== undefined) {
    return {
      worktreeId: explicitWorktreeId || null,
      worktree: resolveLaunchWorktree(explicitWorktreeId, worktreeMap, isInitialized),
    };
  }

  const worktree = inheritedWorktreeId ? (worktreeMap.get(inheritedWorktreeId) ?? null) : null;
  if (
    inheritedWorktreeId &&
    !worktree &&
    isInitialized &&
    !deletedWorktreeIds?.has(inheritedWorktreeId)
  ) {
    return { worktreeId: null, worktree: null };
  }
  return { worktreeId: inheritedWorktreeId, worktree };
}

export interface LaunchAgentOptions {
  location?: AddPanelOptions["location"];
  cwd?: string;
  worktreeId?: string;
  prompt?: string;
  /**
   * `prompt` as the caller wrote it, before `agent.launch` appended a handback
   * instruction (#14592). Recorded on the pane as its first prompt; absent
   * means `prompt` is already as written.
   */
  promptAsWritten?: string;
  /**
   * Handback code already appended to `prompt` by `agent.launch` (#12488).
   * Handed to the spawn so the pty-host looks for its marker.
   */
  handbackCode?: string;
  /**
   * Raw argv pair that appends a standing instruction to the agent's system
   * prompt (#12431), already mapped for this agent by
   * `resolveSystemPromptArgs`. Persisted with the launch flags so every
   * relaunch re-passes it.
   */
  systemPromptArgs?: string[];
  interactive?: boolean;
  modelId?: string;
  presetId?: string | null;
  /** Bypass the availability gate and always attempt to spawn. */
  force?: boolean;
  /**
   * When `location === "dock"`, atomically activate the new panel as the open
   * dock panel in the same `set()` that commits it. See #6590.
   */
  activateDockOnCreate?: boolean;
  /**
   * Extra environment variables to merge into the spawned PTY process.
   * Layered after preset/global env so callers can inject secrets that the
   * agent must read at startup (e.g. `DAINTREE_MCP_TOKEN` for help sessions).
   */
  env?: Record<string, string>;
  /**
   * When true, the spawned panel is excluded from persisted layout snapshots
   * and from user-visible terminal surfaces, and is never rehydrated on app
   * restart. Used by the help panel so the Daintree assistant terminal doesn't
   * reappear in the dock after quit. Independent of `removeOnExit`.
   */
  excludeFromPersistence?: boolean;
  /**
   * When true, the spawned panel is removed immediately when its PTY exits
   * instead of being retained under the trash TTL. Independent of
   * `excludeFromPersistence`.
   */
  removeOnExit?: boolean;
  /**
   * Extra launch flags appended after the resolved settings/preset flags.
   * Used by the help panel to inject user-provided customArgs (e.g. `--model
   * sonnet`) for a single assistant session without changing global agent
   * settings.
   */
  agentLaunchFlags?: string[];
  /**
   * Origin tag stamped onto the resulting panel's `spawnedBy` field. Purely
   * provenance — no focus-policy meaning. Use `focusPolicy` to control
   * whether the new panel captures keyboard focus.
   */
  spawnedBy?: TerminalSpawnSource;
  /**
   * The scheduled run this launch is for (#15977). Makes the pane
   * `spawnedBy: "schedule"` with the run's ids, whatever `spawnedBy` says.
   * Only ever `ActionContext.scheduledRun`.
   */
  scheduledRun?: ScheduledRunRef;
  /**
   * The plugin whose dispatch launched this agent (#14017), stamped as the
   * pane's `launchedByPluginId`. Only ever `ActionContext.callerPluginId`.
   */
  launchedByPluginId?: string;
  /**
   * Focus policy for the new panel. `"preserve"` keeps focus where it is
   * (background/MCP spawns). Omitted defaults to the resolved policy from
   * `panelStore.addPanel` (respects `mcpSpawnFocusSuppression` depth).
   */
  focusPolicy?: AddPanelFocusPolicy;
  /**
   * Pre-reserved terminal ID passed through to `addPanel` so the dock filter
   * is active the moment the panel commits, preventing a one-frame visual
   * flash. Used by the help panel's `+` new-session and run-anyway paths
   * (#6951, #7651).
   */
  requestedId?: string;
  /**
   * Caller-supplied terminal name (e.g. an assistant naming the agent at
   * spawn time). When non-empty after trimming, it overrides the computed
   * title and pins it with `titleMode: "custom"` so agent detection can't
   * rewrite it. Empty/whitespace falls back to the default computed title.
   */
  name?: string;
  /**
   * Told why a launch that resolves to `null` was declined, so a caller that
   * reports the outcome (`agent.launch`) can say more than "not launched".
   * Never called for a launch that returns a result or throws.
   */
  onDecline?: (decline: LaunchDecline) => void;
}

/** Why `launchAgent` resolved to `null` without throwing. */
export type LaunchDeclineReason =
  "panel-limit" | "already-launching" | "spawn-failed" | "unavailable" | "presets-loading";

export interface LaunchDecline {
  reason: LaunchDeclineReason;
  /** The count and limits the refusal was judged on; set only for `panel-limit`. */
  panelLimit: PanelLimitSnapshot | null;
}

export interface LaunchAgentResult extends LaunchAgentIdentity {
  terminalId: string;
  location: "grid" | "dock" | "background";
  /** Atomic launch result: no PTY was started; a setup diagnostic panel was opened. */
  spawnStatus?: "missing-cli";
}

/**
 * Why a launch that would have run without its saved preset didn't start at
 * all: running a different setup than the one chosen is worse than not
 * running, and nothing else on screen would say so. Every caller gets it,
 * whatever it does with the refusal, and the way out is the one that holds
 * for all of them: the agent's preset, to wait on or swap.
 */
function notifyPresetsLoading(
  agentId: string,
  agentName: string,
  worktreeId: string | null | undefined
): void {
  const target = { tab: "agents", subtab: agentId, sectionId: "agents-presets" } as const;
  notify({
    type: "error",
    title: `Couldn't start ${agentName}`,
    message:
      "Its saved preset hasn't loaded yet, so it wasn't started without it. Try again in a moment.",
    context: { eventKind: "agent", ...(worktreeId ? { worktreeId } : {}) },
    urgent: true,
    replaceKey: `launch-presets-loading:${agentId}`,
    action: {
      label: "Open settings",
      actionId: "app.settings.openTab",
      actionArgs: target,
      onClick: () => {
        void import("@/services/ActionService").then(({ actionService }) =>
          actionService.dispatch("app.settings.openTab", target, { source: "user" })
        );
      },
    },
  });
}

export interface UseAgentLauncherReturn {
  launchAgent: (agentId: string, options?: LaunchAgentOptions) => Promise<LaunchAgentResult | null>;
  availability: CliAvailability;
  isCheckingAvailability: boolean;
  agentSettings: AgentSettings | null;
  refreshSettings: () => Promise<void>;
}

export function useAgentLauncher(): UseAgentLauncherReturn {
  const addPanel = usePanelStore((state) => state.addPanel);
  // Read at launch time rather than subscribed, so `launchAgent` keeps its
  // identity across worktree status changes instead of re-minting App's
  // launch callbacks (and the AppLayout props built from them) on every one.
  const worktreeStore = useWorktreeStoreApi();
  const activeWorktreeId = useWorktreeSelectionStore((state) => state.activeWorktreeId);
  const deletedWorktrees = useWorktreeSelectionStore((state) => state.deletedWorktrees);
  const currentProject = useProjectStore((state) => state.currentProject);
  const currentScratch = useScratchStore((state) => state.currentScratch);
  const { homeDir } = useHomeDir();
  const availability = useCliAvailabilityStore((state) => state.availability);
  const isLoading = useCliAvailabilityStore((state) => state.isLoading);
  const isRefreshing = useCliAvailabilityStore((state) => state.isRefreshing);
  const initializeCliAvailability = useCliAvailabilityStore((state) => state.initialize);
  const refreshCliAvailability = useCliAvailabilityStore((state) => state.refresh);

  const agentSettings = useAgentSettingsStore((state) => state.settings);

  const isMounted = useRef(true);
  const launchingAgentsRef = useRef<Set<string>>(new Set());

  const checkAvailabilityAndLoadSettings = useCallback(async () => {
    if (!isElectronAvailable()) {
      return;
    }

    await Promise.allSettled([
      refreshCliAvailability(),
      useAgentSettingsStore.getState().refresh(),
    ]);
  }, [refreshCliAvailability]);

  useEffect(() => {
    isMounted.current = true;

    Promise.allSettled([
      initializeCliAvailability(),
      useAgentSettingsStore.getState().initialize(),
    ]).catch((error) => {
      logError("Failed to load agent settings", error);
    });

    // Re-check availability when the window regains focus so that agents
    // installed or authenticated in the background (e.g. via a terminal
    // outside Daintree) show up without a manual refresh.
    const handleFocus = () => {
      if (!isMounted.current) return;
      void refreshCliAvailability().catch(() => {});
    };
    if (typeof window !== "undefined") {
      window.addEventListener("focus", handleFocus);
    }

    // Re-check availability on system wake so agents installed while the
    // machine was asleep are detected without a manual refresh.
    let cleanupWake: (() => void) | undefined;
    if (typeof window !== "undefined") {
      cleanupWake = systemClient.onWake(() => {
        if (!isMounted.current) return;
        void refreshCliAvailability().catch(() => {});
      });
    }

    return () => {
      isMounted.current = false;
      if (typeof window !== "undefined") {
        window.removeEventListener("focus", handleFocus);
      }
      cleanupWake?.();
    };
  }, [initializeCliAvailability, refreshCliAvailability]);

  const launchAgent = useCallback(
    async (
      agentId: string,
      launchOptions?: LaunchAgentOptions
    ): Promise<LaunchAgentResult | null> => {
      const decline = (
        reason: LaunchDeclineReason,
        panelLimit: PanelLimitSnapshot | null = null
      ): null => {
        launchOptions?.onDecline?.({ reason, panelLimit });
        return null;
      };

      if (!isElectronAvailable()) {
        console.warn("Electron API not available");
        return decline("unavailable");
      }

      // Reentrancy guard scoped per agentId so concurrent launches of different
      // agents (or browser/dev-preview panels) are not blocked.
      // useRef avoids the react batching window that useState would have.
      if (launchingAgentsRef.current.has(agentId)) {
        logWarn(`Declined a launch of ${agentId}: another launch of it is still in progress`);
        return decline("already-launching");
      }
      launchingAgentsRef.current.add(agentId);

      // Per call, so a concurrent launch's refusal can never be read as this one's.
      let limitRefusal: PanelLimitSnapshot | null = null;
      const addPanelCommit = {
        onLimitRefused: (snapshot: PanelLimitSnapshot) => {
          limitRefusal = snapshot;
        },
      };
      const declineAddPanel = (): null =>
        limitRefusal ? decline("panel-limit", limitRefusal) : decline("spawn-failed");

      try {
        // Inside the try: a throw between the add above and the `finally` would
        // strand the entry and leave this agentId unlaunchable for the session.
        markRendererPerformance("agentlaunch.begin", { agentId });
        const { worktrees: worktreeSnapshots, isInitialized } = worktreeStore.getState();
        const { worktreeId: effectiveWorktreeId, worktree: targetWorktree } = resolveLaunchTarget(
          launchOptions?.worktreeId,
          activeWorktreeId,
          getNormalizedWorktreeMap(worktreeSnapshots),
          isInitialized,
          deletedWorktrees
        );

        const cwd =
          launchOptions?.cwd ??
          resolveWorkspaceCwd({
            worktreePath: targetWorktree?.path,
            projectPath: currentProject?.path,
            scratchPath: currentScratch?.path,
            homeDir,
          });

        // Resolved once, spread into every success return so a caller learns
        // where the launch landed without re-deriving it.
        const launchIdentity = buildLaunchIdentity(effectiveWorktreeId, targetWorktree, cwd, {
          // The project's host decides: a Linux host's paths are case-sensitive under any Shell.
          caseInsensitive: isHostMac() || isHostWindows(),
        });

        // Handle browser pane specially
        if (agentId === "browser") {
          try {
            const terminalId = await addPanel(
              {
                kind: "browser",
                cwd,
                worktreeId: effectiveWorktreeId || undefined,
                location: launchOptions?.location,
                activateDockOnCreate: launchOptions?.activateDockOnCreate,
                spawnedBy: launchOptions?.spawnedBy,
              },
              addPanelCommit
            );
            if (!terminalId) return declineAddPanel();
            const rawLocation = usePanelStore.getState().panelsById[terminalId]?.location ?? "grid";
            const location = rawLocation === "dock" ? "dock" : "grid";
            return { terminalId, location, ...launchIdentity };
          } catch (error) {
            logError("Failed to launch browser pane", error);
            return decline("spawn-failed");
          }
        }

        // Handle dev-preview pane specially
        if (agentId === "dev-preview") {
          try {
            // The same command `devServer.start` seeds. Without it a preview
            // opened from the worktree menu or over MCP carries none of its
            // own, so it behaves differently from one opened anywhere else
            // (#11668). Resolved from the view's own project, never the
            // globally-current one.
            const devCommand = await readViewDevServerCommand();
            const terminalId = await addPanel(
              {
                kind: "dev-preview",
                title: "Dev server",
                devCommand,
                cwd,
                worktreeId: effectiveWorktreeId || undefined,
                location: launchOptions?.location,
                activateDockOnCreate: launchOptions?.activateDockOnCreate,
                spawnedBy: launchOptions?.spawnedBy,
              },
              addPanelCommit
            );
            if (!terminalId) return declineAddPanel();
            const rawLocation = usePanelStore.getState().panelsById[terminalId]?.location ?? "grid";
            const location = rawLocation === "dock" ? "dock" : "grid";
            return { terminalId, location, ...launchIdentity };
          } catch (error) {
            logError("Failed to launch dev-preview pane", error);
            return decline("spawn-failed");
          }
        }

        // Get agent config from registry, fall back for "terminal" type.
        // Rejects an id that resolves to no agent before any settings init,
        // command generation, or panel creation — inside the try so the
        // `finally` always releases the reentrancy entry.
        const agentConfig = getAgentConfig(agentId);
        const isAgent = resolveAgentLaunchKind(agentId, isRegisteredAgent(agentId)) === "agent";

        if (agentConfig && !useAgentSettingsStore.getState().isInitialized) {
          await useAgentSettingsStore.getState().initialize();
        }
        const presetScope = { projectId: currentProject?.id, scratchId: currentScratch?.id };
        const presetSources = () => ({
          agentId,
          isAgent,
          worktreeId: effectiveWorktreeId,
          settings: useAgentSettingsStore.getState().settings ?? agentSettings,
          options: launchOptions,
          ...readLaunchPresetSources(agentId, presetScope),
        });
        const declinePresetsLoading = (): null => {
          logWarn(`Declined a launch of ${agentId}: its preset's inventory hasn't loaded`);
          notifyPresetsLoading(agentId, agentConfig?.name ?? agentId, effectiveWorktreeId);
          return decline("presets-loading");
        };
        // A preset that isn't found while its inventory is still loading is
        // waited for, never cleared or launched without (#15025). The wait
        // costs nothing when the preset resolves, which is nearly every launch.
        const presetsSettled =
          !agentConfig ||
          (await waitForLaunchPresets(
            () => findUnloadedLaunchPreset(presetSources()) === undefined
          ));
        if (!isMounted.current) return decline("unavailable");
        if (!presetsSettled) return declinePresetsLoading();
        const plan = await buildAgentLaunchPlan({
          ...presetSources(),
          agentConfig,
          shellDialect: hostShellDialect(),
          resolveBaseCommand: (registryCommand, detail) =>
            resolveAgentLaunchBaseCommand(registryCommand, detail),
          // Hoisted into the plan so the soft-launch gate below reuses this
          // single fetch — avoids a second call (and its potential
          // `refresh(true)` fan-out across all CLIs) on every launch.
          // Background `refreshCliAvailability` (focus / wake handlers) can
          // still race against awaits between this fetch and the gate, but
          // that race is benign and pre-existing: at worst a launch sees a
          // slightly stale `state` and creates the diagnostic panel, which the
          // user can retry.
          getCliDetail: (id) => getCurrentLaunchCliDetail(id),
          getClipboardDirectory: async () =>
            agentClipboardDirectory(
              await resolveHostTmpDir(() => systemClient.getTmpDir()),
              isRemoteWindow()
            ),
          onStalePreset: (scope) => {
            if (scope === "worktree" && effectiveWorktreeId) {
              void useAgentSettingsStore
                .getState()
                .updateWorktreePreset(agentId, effectiveWorktreeId, undefined);
            } else if (scope === "agent") {
              void useAgentSettingsStore.getState().updateAgent(agentId, { presetId: undefined });
            }
          },
        });
        if (plan.unloadedPresetId !== undefined) return declinePresetsLoading();
        const { command, assignedSessionId, preset } = plan;
        const cachedLaunchCliDetail = plan.cliDetail;

        if (isAgent && !command) {
          logWarn(`Cannot launch ${agentId} agent: command could not be generated`);
          return decline("spawn-failed");
        }

        const customTitle = plan.titleMode ? { titleMode: plan.titleMode } : {};
        // Only an agent is handed the prompt as its launch argument.
        const firstPrompt = isAgent
          ? buildFirstPrompt(
              launchOptions?.promptAsWritten ?? launchOptions?.prompt,
              "launch",
              Date.now()
            )
          : undefined;
        const provenance = launchSpawnProvenance(
          launchOptions?.spawnedBy,
          launchOptions?.scheduledRun
        );
        const focusPolicy =
          launchOptions?.focusPolicy ?? (isMcpSpawnFocusSuppressed() ? "preserve" : undefined);

        const options: AddPanelOptions = isAgent
          ? {
              kind: "terminal",
              launchAgentId: agentId,
              command: command as string,
              title: plan.title,
              ...customTitle,
              cwd,
              worktreeId: effectiveWorktreeId || undefined,
              location: launchOptions?.location,
              agentLaunchFlags: plan.launchFlags,
              callerLaunchFlags: plan.callerLaunchFlags,
              agentModelId: plan.modelId,
              agentSessionId: assignedSessionId,
              handbackCode: launchOptions?.handbackCode,
              ...(firstPrompt && { launchPrompt: firstPrompt }),
              agentPresetId: preset?.id,
              agentPresetColor: preset?.color,
              env: plan.env,
              activateDockOnCreate: launchOptions?.activateDockOnCreate,
              excludeFromPersistence: launchOptions?.excludeFromPersistence,
              removeOnExit: launchOptions?.removeOnExit,
              ...provenance,
              launchedByPluginId: launchOptions?.launchedByPluginId,
              focusPolicy,
              requestedId: launchOptions?.requestedId,
            }
          : {
              kind: "terminal",
              title: plan.title,
              ...customTitle,
              cwd,
              worktreeId: effectiveWorktreeId || undefined,
              command,
              location: launchOptions?.location,
              activateDockOnCreate: launchOptions?.activateDockOnCreate,
              excludeFromPersistence: launchOptions?.excludeFromPersistence,
              removeOnExit: launchOptions?.removeOnExit,
              ...provenance,
              focusPolicy,
              requestedId: launchOptions?.requestedId,
            };

        // Soft launch gate: intercept when the CLI is not launchable (missing,
        // installed-but-unlaunchable, or blocked by security software). Creates a
        // diagnostic panel instead of a failed PTY spawn. `unauthenticated` is
        // launchable — the CLI handles first-run auth itself.
        if (isAgent && !launchOptions?.force) {
          // Reuse the detail captured during command construction above.
          // Falls through to a fresh fetch only when there was no agentConfig
          // (defensive — `isAgent` implies `agentConfig` in practice).
          const launchCliDetail =
            cachedLaunchCliDetail ?? (await getCurrentLaunchCliDetail(agentId));
          if (launchCliDetail && !isAgentLaunchable(launchCliDetail.state)) {
            const gateId = `terminal-${crypto.randomUUID()}`;
            const gatePanel: PtyPanelData = {
              id: gateId,
              kind: "terminal",
              launchAgentId: agentId,
              title: plan.title,
              ...customTitle,
              worktreeId: effectiveWorktreeId || undefined,
              cwd,
              cols: 80,
              rows: 24,
              location: launchOptions?.location === "dock" ? "dock" : "grid",
              command: command as string | undefined,
              agentLaunchFlags: plan.launchFlags,
              callerLaunchFlags: plan.callerLaunchFlags,
              agentModelId: plan.modelId,
              agentPresetId: preset?.id,
              agentPresetColor: preset?.color,
              spawnStatus: "missing-cli",
              // "Run anyway" replays the gate's command, prompt included, so
              // the gate holds the launch's record for it. Review Hub shows
              // none for a gate, where nothing ran.
              ...(firstPrompt && { firstPrompt }),
              startedAt: Date.now(),
              isVisible: true,
              extensionState: plan.env ? { presetEnv: plan.env } : undefined,
              excludeFromPersistence: launchOptions?.excludeFromPersistence,
              removeOnExit: launchOptions?.removeOnExit,
              ...provenance,
              focusPolicy,
            };
            // Resolved inside the updater, read after it: the gate may reuse a
            // panel that already exists rather than the id minted above.
            let resolvedGateId = gateId;
            usePanelStore.setState((state) => {
              // The in-flight guard above only spans a single call, so repeated
              // clicks on an unavailable agent would each append another gate.
              const existingGateId = findEquivalentMissingCliGate(
                state.panelsById,
                state.panelIds,
                gatePanel,
                { requestedId: launchOptions?.requestedId }
              );
              resolvedGateId = existingGateId ?? gateId;

              const next: Partial<typeof state> = existingGateId
                ? {}
                : {
                    panelsById: { ...state.panelsById, [gateId]: gatePanel },
                    panelIds: [...state.panelIds, gateId],
                    // The gate panel bypasses `addPanel`, so it must join the
                    // per-worktree index here — sidebar summaries and worktree
                    // cycling derive terminal counts from it.
                    panelIdsByWorktreeId: addToWorktreeIndex(
                      state.panelIdsByWorktreeId,
                      gatePanel.worktreeId,
                      gateId
                    ),
                  };
              // Atomic dock activation — same race fix as `addPanel`. The gate
              // panel bypasses `addPanel`, so the activation must be folded
              // into this `set()` directly. See #6590.
              if (launchOptions?.activateDockOnCreate && launchOptions?.location === "dock") {
                const prevFocusedId = state.focusedId ?? null;
                const focusActuallyChanged = resolvedGateId !== prevFocusedId;
                next.activeDockTerminalId = resolvedGateId;
                // Focus-preserve launches still expose the gate panel in the
                // dock but never claim keyboard focus. See #6959.
                if (focusPolicy !== "preserve") {
                  next.focusedId = resolvedGateId;
                  if (focusActuallyChanged) {
                    next.previousFocusedId = prevFocusedId;
                  }
                }
              }
              return next;
            });

            // Grid gates bypass `addPanel`, so they never inherited its focus
            // handling. Both halves matter: a gate created behind a maximized
            // panel renders nowhere (#11060), and without taking focus the
            // keyboard is stranded — the toolbar button blurs on click and the
            // launcher suppresses its own focus return because this IS a launch.
            // Reuse needs it too, or a repeated click reads as a dead button.
            // `setFocused` rather than a raw write, so the dock/recency
            // invariants it owns keep holding.
            const takesFocus =
              gatePanel.location !== "dock" &&
              focusPolicy !== "preserve" &&
              !(focusPolicy === undefined && isAssistantFocused());
            if (takesFocus) {
              usePanelStore.getState().exitMaximize();
              exitProjectHome();
              usePanelStore.getState().setFocused(resolvedGateId);
            }
            return {
              terminalId: resolvedGateId,
              location: gatePanel.location === "dock" ? "dock" : "grid",
              spawnStatus: "missing-cli" as const,
              ...launchIdentity,
            };
          }
        }

        try {
          markRendererPerformance("agentlaunch.addpanel", { agentId });
          const terminalId = await addPanel(options, addPanelCommit);
          if (!terminalId) return declineAddPanel();
          const rawLocation = usePanelStore.getState().panelsById[terminalId]?.location ?? "grid";
          // "background" only when the caller parked it: a panel the user
          // backgrounded in the meantime still reports where the launch put it.
          const location =
            rawLocation === "dock"
              ? "dock"
              : rawLocation === "background" && launchOptions?.location === "background"
                ? "background"
                : "grid";
          return { terminalId, location, ...launchIdentity };
        } catch (error) {
          logError(`Failed to launch ${agentId} agent`, error);
          return decline("spawn-failed");
        }
      } finally {
        launchingAgentsRef.current.delete(agentId);
      }
    },
    [
      activeWorktreeId,
      deletedWorktrees,
      worktreeStore,
      addPanel,
      currentProject,
      currentScratch,
      agentSettings,
      homeDir,
    ]
  );

  return {
    launchAgent,
    availability,
    isCheckingAvailability: isLoading || isRefreshing,
    agentSettings,
    refreshSettings: checkAvailabilityAndLoadSettings,
  };
}
