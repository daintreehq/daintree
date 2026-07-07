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
import { escapeShellArgOptional, isWindows } from "@shared/utils/shellEscape";
import {
  getAgentConfig,
  isRegisteredAgent,
  getAgentDisplayTitle,
  getMergedPreset,
  sanitizeAgentEnv,
} from "@/config/agents";
import type { AgentCliDetail } from "@shared/types/ipc";
import { applyPresetBehaviorOverrides } from "@/utils/agentRuntimeSettings";

const CLIPBOARD_DIR_NAME = "daintree-clipboard";

function escapePowerShellSingleQuoted(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Sanitize an assistant-supplied terminal name for use as a panel title.
 * Strips ASCII control characters (an LLM could emit newlines, tabs, or ANSI
 * escape sequences), collapses internal whitespace, and trims. Returns "" when
 * nothing printable remains, which the caller treats as "no name" (falls back
 * to the default computed title with no `titleMode` pin).
 */
function sanitizeTerminalName(raw: string): string {
  let out = "";
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    // Drop C0 controls (0x00–0x1f) and DEL (0x7f); replace with a space so
    // adjacent words don't fuse, then collapse the runs below.
    out += code <= 0x1f || code === 0x7f ? " " : ch;
  }
  return out.replace(/\s+/g, " ").trim();
}

/**
 * Resolve the worktree a launch should target. When a `targetWorktreeId` is
 * supplied but matches no known worktree (and the worktree map has finished
 * loading), this throws instead of returning null so the failure surfaces as a
 * real error to callers — notably the MCP `agent.launch` path, where a silent
 * null was serialized as a terminal-less success and triggered client retry
 * loops (#10812). The thrown message lists the available IDs so a model client
 * can self-correct. Before the map is initialized we cannot assert "not found",
 * so we fall through and let the caller use its cwd fallbacks.
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

export interface UseAgentLauncherReturn {
  launchAgent: (
    agentId: string,
    options?: LaunchAgentOptions
  ) => Promise<{ terminalId: string; location: "grid" | "dock" } | null>;
  availability: CliAvailability;
  isCheckingAvailability: boolean;
  agentSettings: AgentSettings | null;
  refreshSettings: () => Promise<void>;
}

export function resolveAgentLaunchBaseCommand(
  registryCommand: string,
  detail: AgentCliDetail | undefined,
  platform?: "posix" | "windows"
): string {
  const resolvedPath =
    detail &&
    detail.state !== "missing" &&
    detail.state !== "blocked" &&
    detail.state !== "installed"
      ? detail.resolvedPath?.trim()
      : undefined;

  // When there's no availability-resolved path, fall back to the registry
  // command. A bare PATH binary name (built-in agents) passes through unchanged.
  // A plugin-contributed command resolved to an absolute path (#10560) is
  // escaped like a resolved path so spaces in the plugin dir — e.g. macOS's
  // "Application Support" — don't split the spawned command string.
  const effective = resolvedPath ?? registryCommand;
  const isPathLike = effective.includes("/") || effective.includes("\\");
  if (!resolvedPath && !isPathLike) return registryCommand;

  const useWindows = platform ? platform === "windows" : isWindows();
  if (useWindows) {
    return `& ${escapePowerShellSingleQuoted(effective)}`;
  }

  return escapeShellArgOptional(effective, "posix");
}

async function getCurrentLaunchCliDetail(agentId: string): Promise<AgentCliDetail | undefined> {
  const current = useCliAvailabilityStore.getState().details[agentId];
  if (
    (current?.state === "ready" || current?.state === "unauthenticated") &&
    current.resolvedPath?.trim()
  ) {
    return current;
  }

  try {
    await useCliAvailabilityStore.getState().refresh(true);
  } catch {
    // Launch can still fall back to the registry command; availability UI
    // surfaces the refresh error separately.
  }

  return useCliAvailabilityStore.getState().details[agentId];
}

export function useAgentLauncher(): UseAgentLauncherReturn {
  const addPanel = usePanelStore((state) => state.addPanel);
  const { worktreeMap, isInitialized } = useWorktrees();
  const activeWorktreeId = useWorktreeSelectionStore((state) => state.activeWorktreeId);
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
    ): Promise<{ terminalId: string; location: "grid" | "dock" } | null> => {
      if (!isElectronAvailable()) {
        console.warn("Electron API not available");
        return null;
      }

      // Reentrancy guard scoped per agentId so concurrent launches of different
      // agents (or browser/dev-preview panels) are not blocked.
      // useRef avoids the react batching window that useState would have.
      if (launchingAgentsRef.current.has(agentId)) return null;
      launchingAgentsRef.current.add(agentId);
      markRendererPerformance("agentlaunch.begin", { agentId });

      try {
        const targetWorktreeId = launchOptions?.worktreeId ?? activeWorktreeId;
        const targetWorktree = resolveLaunchWorktree(targetWorktreeId, worktreeMap, isInitialized);

        const cwd =
          launchOptions?.cwd ??
          targetWorktree?.path ??
          currentScratch?.path ??
          currentProject?.path ??
          homeDir ??
          "";

        // Handle browser pane specially
        if (agentId === "browser") {
          try {
            const terminalId = await addPanel({
              kind: "browser",
              cwd,
              worktreeId: targetWorktreeId || undefined,
              location: launchOptions?.location,
              activateDockOnCreate: launchOptions?.activateDockOnCreate,
              spawnedBy: launchOptions?.spawnedBy,
            });
            if (!terminalId) return null;
            const rawLocation = usePanelStore.getState().panelsById[terminalId]?.location ?? "grid";
            const location = rawLocation === "dock" ? "dock" : "grid";
            return { terminalId, location };
          } catch (error) {
            logError("Failed to launch browser pane", error);
            return null;
          }
        }

        // Handle dev-preview pane specially
        if (agentId === "dev-preview") {
          try {
            const terminalId = await addPanel({
              kind: "dev-preview",
              title: "Dev Server",
              cwd,
              worktreeId: targetWorktreeId || undefined,
              location: launchOptions?.location,
              activateDockOnCreate: launchOptions?.activateDockOnCreate,
              spawnedBy: launchOptions?.spawnedBy,
            });
            if (!terminalId) return null;
            const rawLocation = usePanelStore.getState().panelsById[terminalId]?.location ?? "grid";
            const location = rawLocation === "dock" ? "dock" : "grid";
            return { terminalId, location };
          } catch (error) {
            logError("Failed to launch dev-preview pane", error);
            return null;
          }
        }

        // Get agent config from registry, fall back for "terminal" type
        const agentConfig = getAgentConfig(agentId);
        const isAgent = isRegisteredAgent(agentId);

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
          const savedPresetId = resolveEffectivePresetId(entry, targetWorktreeId);
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
            targetWorktreeId && entry.worktreePresets
              ? entry.worktreePresets[targetWorktreeId]
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
            if (scopedId && scopedId === resolvedPresetId && targetWorktreeId) {
              void settingsStore
                .getState()
                .updateWorktreePreset(agentId, targetWorktreeId, undefined);
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
              worktreeId: targetWorktreeId || undefined,
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
              worktreeId: targetWorktreeId || undefined,
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
              worktreeId: targetWorktreeId || undefined,
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
            };
          }
        }

        try {
          markRendererPerformance("agentlaunch.addpanel", { agentId });
          const terminalId = await addPanel(options);
          if (!terminalId) return null;
          const rawLocation = usePanelStore.getState().panelsById[terminalId]?.location ?? "grid";
          const location = rawLocation === "dock" ? "dock" : "grid";
          return { terminalId, location };
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
