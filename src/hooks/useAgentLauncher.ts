import { useCallback, useEffect, useRef } from "react";
import { usePanelStore, type AddPanelOptions } from "@/store/panelStore";
import type { PtyPanelData } from "@shared/types/panel";
import { useProjectStore } from "@/store/projectStore";
import { useScratchStore } from "@/store/scratchStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { isMcpSpawnFocusSuppressed } from "@/store/mcpSpawnFocusGuard";
import { useCliAvailabilityStore } from "@/store/cliAvailabilityStore";
import { useWorktrees } from "./useWorktrees";
import { isElectronAvailable } from "./useElectron";

import { systemClient } from "@/clients";
import { useHomeDir } from "@/hooks/app/useHomeDir";
import { logError, logWarn } from "@/utils/logger";
import { markRendererPerformance } from "@/utils/performance";
import { resolveWorkspaceCwd } from "@/utils/workspaceCwd";
import { readViewDevServerCommand } from "@/utils/devServerCommand";
import { useCcrPresetsStore } from "@/store/ccrPresetsStore";
import { useProjectPresetsStore } from "@/store/projectPresetsStore";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import { addToWorktreeIndex } from "@/store/slices/panelRegistry/worktreeIndex";
import type {
  AgentSettings,
  CliAvailability,
  TerminalSpawnSource,
  AddPanelFocusPolicy,
} from "@shared/types";
import {
  generateAgentCommand,
  buildAgentLaunchFlags,
  resolveEffectivePresetId,
} from "@shared/types";
import { isAgentLaunchable } from "@shared/utils/agentAvailability";
import { escapeShellArgOptional } from "@shared/utils/shellEscape";
import {
  getAgentConfig,
  isRegisteredAgent,
  getAgentDisplayTitle,
  getMergedPreset,
  sanitizeAgentEnv,
} from "@/config/agents";
import type { AgentCliDetail } from "@shared/types/ipc";
import { applyPresetBehaviorOverrides } from "@/utils/agentRuntimeSettings";
import {
  getCurrentLaunchCliDetail,
  resolveAgentLaunchBaseCommand,
} from "@/utils/agentLaunchCommand";
import { resolveAgentLaunchKind, sanitizeTerminalName } from "@/utils/agentLaunchValidation";

export { resolveAgentLaunchBaseCommand } from "@/utils/agentLaunchCommand";
// Re-exported so the hook stays the canonical import site for launch-path
// callers; the action layer imports the pure module directly (#11547).
export { resolveAgentLaunchKind } from "@/utils/agentLaunchValidation";

const CLIPBOARD_DIR_NAME = "daintree-clipboard";

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
}

/**
 * Where a launch landed. Resolved before the panel is created, so it
 * accompanies every non-null launch result — a caller driving several launches
 * at once can map a terminal back to its worktree without re-resolving the
 * target itself and reconciling afterwards (#11547).
 */
export interface LaunchAgentIdentity {
  /** Resolved target worktree, or null when the launch is outside one. */
  worktreeId: string | null;
  /** Absolute path of the resolved worktree; null when there is none. */
  worktreePath: string | null;
  /** Branch of the resolved worktree; null when detached or absent. */
  branch: string | null;
  /** Directory the panel was created with; null when none resolved. */
  cwd: string | null;
}

/**
 * Build the identity reported alongside a launch. Extracted as a pure helper so
 * the four return points in `launchAgent` share one construction and it stays
 * testable without mounting the hook — same reason `resolveLaunchWorktree` and
 * `resolveAgentLaunchKind` are separate.
 *
 * `cwd` is normalized from `""` to null: `resolveWorkspaceCwd` returns an empty
 * string when nothing at all resolves, and main reads a falsy cwd as "use the
 * home dir". Reporting `""` would name a directory the process never runs in.
 *
 * `worktreeId` is reported even when `targetWorktree` is null (the map has not
 * initialized yet, so the id could not be looked up) because that is the id the
 * panel is actually created with — the path and branch stay null since neither
 * is known.
 */
export function buildLaunchIdentity(
  targetWorktreeId: string | null | undefined,
  targetWorktree: { path?: string; branch?: string } | null,
  cwd: string
): LaunchAgentIdentity {
  return {
    worktreeId: targetWorktreeId || null,
    worktreePath: targetWorktree?.path ?? null,
    branch: targetWorktree?.branch ?? null,
    cwd: cwd || null,
  };
}

export interface LaunchAgentResult extends LaunchAgentIdentity {
  terminalId: string;
  location: "grid" | "dock";
  /** Atomic launch result: no PTY was started; a setup diagnostic panel was opened. */
  spawnStatus?: "missing-cli";
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
  const { worktreeMap, isInitialized } = useWorktrees();
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
      if (!isElectronAvailable()) {
        console.warn("Electron API not available");
        return null;
      }

      // Reentrancy guard scoped per agentId so concurrent launches of different
      // agents (or browser/dev-preview panels) are not blocked.
      // useRef avoids the react batching window that useState would have.
      if (launchingAgentsRef.current.has(agentId)) return null;
      launchingAgentsRef.current.add(agentId);

      try {
        // Inside the try: a throw between the add above and the `finally` would
        // strand the entry and leave this agentId unlaunchable for the session.
        markRendererPerformance("agentlaunch.begin", { agentId });
        const { worktreeId: effectiveWorktreeId, worktree: targetWorktree } = resolveLaunchTarget(
          launchOptions?.worktreeId,
          activeWorktreeId,
          worktreeMap,
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
        const launchIdentity = buildLaunchIdentity(effectiveWorktreeId, targetWorktree, cwd);

        // Handle browser pane specially
        if (agentId === "browser") {
          try {
            const terminalId = await addPanel({
              kind: "browser",
              cwd,
              worktreeId: effectiveWorktreeId || undefined,
              location: launchOptions?.location,
              activateDockOnCreate: launchOptions?.activateDockOnCreate,
              spawnedBy: launchOptions?.spawnedBy,
            });
            if (!terminalId) return null;
            const rawLocation = usePanelStore.getState().panelsById[terminalId]?.location ?? "grid";
            const location = rawLocation === "dock" ? "dock" : "grid";
            return { terminalId, location, ...launchIdentity };
          } catch (error) {
            logError("Failed to launch browser pane", error);
            return null;
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
            const terminalId = await addPanel({
              kind: "dev-preview",
              title: "Dev Server",
              devCommand,
              cwd,
              worktreeId: effectiveWorktreeId || undefined,
              location: launchOptions?.location,
              activateDockOnCreate: launchOptions?.activateDockOnCreate,
              spawnedBy: launchOptions?.spawnedBy,
            });
            if (!terminalId) return null;
            const rawLocation = usePanelStore.getState().panelsById[terminalId]?.location ?? "grid";
            const location = rawLocation === "dock" ? "dock" : "grid";
            return { terminalId, location, ...launchIdentity };
          } catch (error) {
            logError("Failed to launch dev-preview pane", error);
            return null;
          }
        }

        // Get agent config from registry, fall back for "terminal" type.
        // Rejects an id that resolves to no agent before any settings init,
        // command generation, or panel creation — inside the try so the
        // `finally` always releases the reentrancy entry.
        const agentConfig = getAgentConfig(agentId);
        const isAgent = resolveAgentLaunchKind(agentId, isRegisteredAgent(agentId)) === "agent";

        let command: string | undefined;
        let launchFlags: string[] | undefined;
        let presetEnv: Record<string, string> | undefined;
        let preset: import("../../shared/config/agentRegistry").AgentPreset | undefined;
        // Hoisted so the soft-launch gate below reuses the result of the
        // single fetch inside the agentConfig block — avoids a second call
        // (and its potential `refresh(true)` fan-out across all CLIs) on
        // every launch. Background `refreshCliAvailability` (focus / wake
        // handlers) can still race against awaits between this fetch and
        // the gate, but that race is benign and pre-existing: at worst a
        // launch sees a slightly stale `state` and creates the diagnostic
        // panel, which the user can retry.
        let cachedLaunchCliDetail: AgentCliDetail | undefined;
        if (agentConfig) {
          if (!useAgentSettingsStore.getState().isInitialized) {
            await useAgentSettingsStore.getState().initialize();
          }
          const launchSettings = useAgentSettingsStore.getState().settings ?? agentSettings;
          const entry = launchSettings?.agents?.[agentId] ?? {};
          // null = explicitly default — skip preset lookup entirely
          // undefined = use saved preset for this worktree (or agent-level
          //   default, or nothing). Worktree-scoped override wins over the
          //   agent-level `presetId` so switching worktrees doesn't silently
          //   surface another worktree's pick.
          const explicitDefault = launchOptions?.presetId === null;
          const savedPresetId = resolveEffectivePresetId(entry, effectiveWorktreeId);
          const resolvedPresetId = explicitDefault
            ? undefined
            : (launchOptions?.presetId ?? savedPresetId);
          const ccrPresets = useCcrPresetsStore.getState().ccrPresetsByAgent[agentId];
          const projectPresets = useProjectPresetsStore.getState().presetsByAgent[agentId];
          const primaryPreset =
            isAgent && !explicitDefault
              ? getMergedPreset(
                  agentId,
                  resolvedPresetId,
                  entry.customPresets,
                  ccrPresets,
                  projectPresets
                )
              : undefined;
          preset = primaryPreset;

          // Fallback for this launch: if the worktree-scoped pick is stale but
          // the agent-level default is still valid, use the agent default now.
          // Without this, a deleted scoped preset would launch preset-free even
          // when a valid global fallback exists. The stale scoped slot is still
          // cleared below so the next launch resolves directly against global.
          const scopedId =
            effectiveWorktreeId && entry.worktreePresets
              ? entry.worktreePresets[effectiveWorktreeId]
              : undefined;
          if (
            !primaryPreset &&
            isAgent &&
            !explicitDefault &&
            launchOptions?.presetId === undefined &&
            scopedId &&
            scopedId === resolvedPresetId &&
            entry.presetId &&
            entry.presetId !== scopedId
          ) {
            preset = getMergedPreset(
              agentId,
              entry.presetId,
              entry.customPresets,
              ccrPresets,
              projectPresets
            );
          }

          // Stale presetId cleanup: clear whichever scope held the vanished ID.
          // The worktree slot wins at resolution time, so only fall through to
          // clearing the agent-level default when that's what the launch used.
          if (resolvedPresetId && !primaryPreset) {
            const { useAgentSettingsStore: settingsStore } =
              await import("@/store/agentSettingsStore");
            if (scopedId && scopedId === resolvedPresetId && effectiveWorktreeId) {
              void settingsStore
                .getState()
                .updateWorktreePreset(agentId, effectiveWorktreeId, undefined);
            } else if (entry.presetId && entry.presetId === resolvedPresetId) {
              void settingsStore.getState().updateAgent(agentId, { presetId: undefined });
            }
          }

          // Merge: global env (base) overridden by preset env (preset wins on conflicts).
          // Caller-supplied launchOptions.env layers on top of both — used for
          // session-bound secrets like DAINTREE_MCP_TOKEN.
          const sanitizedGlobal = sanitizeAgentEnv(entry.globalEnv as Record<string, unknown>);
          const sanitizedPreset = preset?.env;
          const callerEnv = launchOptions?.env;
          if (sanitizedGlobal || sanitizedPreset || callerEnv) {
            presetEnv = { ...sanitizedGlobal, ...sanitizedPreset, ...callerEnv };
          }

          // Merge per-preset behavioral overrides (incl. tri-state bypass mode)
          // on top of agent-level settings via the shared resolver.
          const effectiveEntry = applyPresetBehaviorOverrides(entry, preset);

          // Resolve clipboard directory for agents that need it (e.g. Gemini)
          let clipboardDirectory: string | undefined;
          if (agentId === "gemini" && effectiveEntry.shareClipboardDirectory !== false) {
            try {
              const tmpDir = await systemClient.getTmpDir();
              clipboardDirectory = `${tmpDir}/${CLIPBOARD_DIR_NAME}`;
            } catch {
              // Non-critical: Gemini will work without clipboard access
            }
          }

          cachedLaunchCliDetail = await getCurrentLaunchCliDetail(agentId);
          const baseCommand = resolveAgentLaunchBaseCommand(
            agentConfig.command,
            cachedLaunchCliDetail
          );
          const globalSkipPermissions = launchSettings?.globalSkipPermissions ?? false;
          const globalUseAltScreen = launchSettings?.globalUseAltScreen ?? false;
          command = generateAgentCommand(baseCommand, effectiveEntry, agentId, {
            initialPrompt: launchOptions?.prompt,
            interactive: launchOptions?.interactive ?? true,
            clipboardDirectory,
            modelId: launchOptions?.modelId,
            presetArgs: preset?.args?.join(" "),
            globalSkipPermissions,
            globalUseAltScreen,
          });

          // Capture process-level flags for session resume persistence
          if (isAgent) {
            launchFlags = buildAgentLaunchFlags(effectiveEntry, agentId, {
              modelId: launchOptions?.modelId,
              presetArgs: preset?.args,
              globalSkipPermissions,
              globalUseAltScreen,
            });
          }

          // Append caller-supplied launch flags last so they override
          // earlier flag values (argv parsers typically take the last
          // occurrence, e.g. `--model sonnet` after a preset's `--model`).
          // Mirrored into both the spawn command string and the persisted
          // `launchFlags` array so resume reproduces the same configuration.
          const extraFlags = launchOptions?.agentLaunchFlags;
          if (extraFlags?.length) {
            const appendedTokens: string[] = [];
            for (const flag of extraFlags) {
              if (!flag) continue;
              appendedTokens.push(flag.startsWith("-") ? flag : escapeShellArgOptional(flag));
            }
            if (appendedTokens.length) {
              command = `${command} ${appendedTokens.join(" ")}`;
            }
            if (isAgent) {
              launchFlags = [...(launchFlags ?? []), ...extraFlags.filter(Boolean)];
            }
          }
        }

        const title =
          launchOptions?.modelId && isAgent
            ? getAgentDisplayTitle(agentId, launchOptions.modelId)
            : (agentConfig?.name ?? "Terminal");

        if (isAgent && !command) {
          logWarn(`Cannot launch ${agentId} agent: command could not be generated`);
          return null;
        }

        // Preset title: an explicit `displayTitle` wins verbatim; otherwise
        // compose the agent name with the preset in brackets ("Claude [Z.ai]")
        // so the active preset is visible next to the agent name. Pinned as
        // "custom" below so the agent-detected title sync can't overwrite it
        // with the bare agent name.
        let presetTitle = title;
        let hasPresetTitle = false;
        if (isAgent && preset) {
          const presetName = preset.name?.trim();
          if (presetName) {
            hasPresetTitle = true;
            presetTitle = preset.displayTitle?.trim()
              ? preset.displayTitle
              : `${title} [${presetName}]`;
          }
        }
        // A caller-supplied name overrides the computed title and pins it so
        // agent detection can't rewrite it. Strip control characters (an LLM
        // assistant could emit newlines/ANSI/tabs) and collapse whitespace so
        // tab chrome and aria labels stay intact. Empty/whitespace after
        // sanitizing is treated as no name — fall back to the default title
        // with no `titleMode`.
        const trimmedName = launchOptions?.name
          ? sanitizeTerminalName(launchOptions.name)
          : undefined;
        // Pin any non-default title (caller name OR preset) as "custom" so the
        // agent-detected title sync (computeDefaultTitle) can't clobber it.
        const customTitle = trimmedName || hasPresetTitle ? { titleMode: "custom" as const } : {};
        const spawnedBy = launchOptions?.spawnedBy;
        const focusPolicy =
          launchOptions?.focusPolicy ?? (isMcpSpawnFocusSuppressed() ? "preserve" : undefined);

        const options: AddPanelOptions = isAgent
          ? {
              kind: "terminal",
              launchAgentId: agentId,
              command: command as string,
              title: trimmedName || presetTitle,
              ...customTitle,
              cwd,
              worktreeId: effectiveWorktreeId || undefined,
              location: launchOptions?.location,
              agentLaunchFlags: launchFlags,
              agentModelId: launchOptions?.modelId,
              agentPresetId: preset?.id,
              agentPresetColor: preset?.color,
              env: presetEnv,
              activateDockOnCreate: launchOptions?.activateDockOnCreate,
              excludeFromPersistence: launchOptions?.excludeFromPersistence,
              removeOnExit: launchOptions?.removeOnExit,
              spawnedBy,
              focusPolicy,
              requestedId: launchOptions?.requestedId,
            }
          : {
              kind: "terminal",
              title: trimmedName || title,
              ...customTitle,
              cwd,
              worktreeId: effectiveWorktreeId || undefined,
              command,
              location: launchOptions?.location,
              activateDockOnCreate: launchOptions?.activateDockOnCreate,
              excludeFromPersistence: launchOptions?.excludeFromPersistence,
              removeOnExit: launchOptions?.removeOnExit,
              spawnedBy,
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
              title: trimmedName || presetTitle,
              ...customTitle,
              worktreeId: effectiveWorktreeId || undefined,
              cwd,
              cols: 80,
              rows: 24,
              location: launchOptions?.location === "dock" ? "dock" : "grid",
              command: command as string | undefined,
              agentLaunchFlags: launchFlags,
              agentModelId: launchOptions?.modelId,
              agentPresetId: preset?.id,
              agentPresetColor: preset?.color,
              spawnStatus: "missing-cli",
              startedAt: Date.now(),
              isVisible: true,
              extensionState: presetEnv ? { presetEnv } : undefined,
              excludeFromPersistence: launchOptions?.excludeFromPersistence,
              removeOnExit: launchOptions?.removeOnExit,
              spawnedBy,
              focusPolicy,
            };
            usePanelStore.setState((state) => {
              const next: Partial<typeof state> = {
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
                const focusActuallyChanged = gateId !== prevFocusedId;
                next.activeDockTerminalId = gateId;
                // Focus-preserve launches still expose the gate panel in the
                // dock but never claim keyboard focus. See #6959.
                if (focusPolicy !== "preserve") {
                  next.focusedId = gateId;
                  if (focusActuallyChanged) {
                    next.previousFocusedId = prevFocusedId;
                  }
                }
              }
              return next;
            });
            return {
              terminalId: gateId,
              location: gatePanel.location === "dock" ? "dock" : "grid",
              spawnStatus: "missing-cli" as const,
              ...launchIdentity,
            };
          }
        }

        try {
          markRendererPerformance("agentlaunch.addpanel", { agentId });
          const terminalId = await addPanel(options);
          if (!terminalId) return null;
          const rawLocation = usePanelStore.getState().panelsById[terminalId]?.location ?? "grid";
          const location = rawLocation === "dock" ? "dock" : "grid";
          return { terminalId, location, ...launchIdentity };
        } catch (error) {
          logError(`Failed to launch ${agentId} agent`, error);
          return null;
        }
      } finally {
        launchingAgentsRef.current.delete(agentId);
      }
    },
    [
      activeWorktreeId,
      deletedWorktrees,
      worktreeMap,
      isInitialized,
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
