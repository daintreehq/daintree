import { useCallback, useEffect, useRef, useState } from "react";
import { usePanelStore, type AddPanelOptions, type TerminalInstance } from "@/store/panelStore";
import { useProjectStore } from "@/store/projectStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useCliAvailabilityStore } from "@/store/cliAvailabilityStore";
import { useWorktrees } from "./useWorktrees";
import { isElectronAvailable } from "./useElectron";

import { agentSettingsClient, systemClient } from "@/clients";
import { useHomeDir } from "@/hooks/app/useHomeDir";
import { logError, logWarn } from "@/utils/logger";
import { useCcrPresetsStore } from "@/store/ccrPresetsStore";
import { useProjectPresetsStore } from "@/store/projectPresetsStore";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import type { AgentSettings, CliAvailability } from "@shared/types";
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

const CLIPBOARD_DIR_NAME = "daintree-clipboard";

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
}

export interface UseAgentLauncherReturn {
  launchAgent: (agentId: string, options?: LaunchAgentOptions) => Promise<string | null>;
  availability: CliAvailability;
  isCheckingAvailability: boolean;
  agentSettings: AgentSettings | null;
  refreshSettings: () => Promise<void>;
}

export function resolveAgentLaunchBaseCommand(
  registryCommand: string,
  detail: AgentCliDetail | undefined
): string {
  const resolvedPath =
    detail &&
    detail.state !== "missing" &&
    detail.state !== "blocked" &&
    detail.state !== "installed"
      ? detail.resolvedPath?.trim()
      : undefined;
  return resolvedPath ? escapeShellArgOptional(resolvedPath) : registryCommand;
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
  const { homeDir } = useHomeDir();
  const availability = useCliAvailabilityStore((state) => state.availability);
  const isLoading = useCliAvailabilityStore((state) => state.isLoading);
  const isRefreshing = useCliAvailabilityStore((state) => state.isRefreshing);
  const initializeCliAvailability = useCliAvailabilityStore((state) => state.initialize);
  const refreshCliAvailability = useCliAvailabilityStore((state) => state.refresh);

  const [agentSettings, setAgentSettings] = useState<AgentSettings | null>(null);

  const isMounted = useRef(true);
  const launchingAgentsRef = useRef<Set<string>>(new Set());

  const checkAvailabilityAndLoadSettings = useCallback(async () => {
    if (!isElectronAvailable()) {
      return;
    }

    const [, settingsResult] = await Promise.allSettled([
      refreshCliAvailability(),
      agentSettingsClient.get(),
    ]);

    if (isMounted.current && settingsResult.status === "fulfilled" && settingsResult.value) {
      setAgentSettings(settingsResult.value);
    }
  }, [refreshCliAvailability]);

  useEffect(() => {
    isMounted.current = true;

    Promise.allSettled([
      initializeCliAvailability(),
      agentSettingsClient.get(),
      useAgentSettingsStore.getState().initialize(),
    ])
      .then(([, settingsResult]) => {
        if (!isMounted.current) return;
        if (settingsResult.status === "fulfilled" && settingsResult.value) {
          setAgentSettings(settingsResult.value);
        }
      })
      .catch((error) => {
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
    async (agentId: string, launchOptions?: LaunchAgentOptions): Promise<string | null> => {
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
        const targetWorktreeId = launchOptions?.worktreeId ?? activeWorktreeId;
        const targetWorktree = targetWorktreeId ? worktreeMap.get(targetWorktreeId) : null;

        if (targetWorktreeId && !targetWorktree && isInitialized) {
          console.warn(`Worktree ${targetWorktreeId} not found, cannot launch agent`);
          return null;
        }

        const cwd =
          launchOptions?.cwd ?? targetWorktree?.path ?? currentProject?.path ?? homeDir ?? "";

        // Handle browser pane specially
        if (agentId === "browser") {
          try {
            const terminalId = await addPanel({
              kind: "browser",
              cwd,
              worktreeId: targetWorktreeId || undefined,
              location: launchOptions?.location,
              activateDockOnCreate: launchOptions?.activateDockOnCreate,
            });
            return terminalId;
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
            });
            return terminalId;
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
        if (agentConfig) {
          const entry = agentSettings?.agents?.[agentId] ?? {};
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

          // Merge per-preset behavioral overrides on top of agent-level settings
          const effectiveEntry = preset
            ? {
                ...entry,
                ...(preset.dangerousEnabled !== undefined && {
                  dangerousEnabled: preset.dangerousEnabled,
                }),
                ...(preset.customFlags !== undefined && { customFlags: preset.customFlags }),
                ...(preset.inlineMode !== undefined && { inlineMode: preset.inlineMode }),
              }
            : entry;

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

          const launchCliDetail = await getCurrentLaunchCliDetail(agentId);
          const baseCommand = resolveAgentLaunchBaseCommand(agentConfig.command, launchCliDetail);
          command = generateAgentCommand(baseCommand, effectiveEntry, agentId, {
            initialPrompt: launchOptions?.prompt,
            interactive: launchOptions?.interactive ?? true,
            clipboardDirectory,
            modelId: launchOptions?.modelId,
            presetArgs: preset?.args?.join(" "),
          });

          // Capture process-level flags for session resume persistence
          if (isAgent) {
            launchFlags = buildAgentLaunchFlags(effectiveEntry, agentId, {
              modelId: launchOptions?.modelId,
              presetArgs: preset?.args,
            });
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

        const presetTitle = isAgent && preset ? preset.name : title;

        const options: AddPanelOptions = isAgent
          ? {
              kind: "terminal",
              launchAgentId: agentId,
              command: command as string,
              title: presetTitle,
              cwd,
              worktreeId: targetWorktreeId || undefined,
              location: launchOptions?.location,
              agentLaunchFlags: launchFlags,
              agentModelId: launchOptions?.modelId,
              agentPresetId: preset?.id,
              agentPresetColor: preset?.color,
              env: presetEnv,
              activateDockOnCreate: launchOptions?.activateDockOnCreate,
            }
          : {
              kind: "terminal",
              title,
              cwd,
              worktreeId: targetWorktreeId || undefined,
              command,
              location: launchOptions?.location,
              activateDockOnCreate: launchOptions?.activateDockOnCreate,
            };

        // Soft launch gate: intercept when the CLI is not launchable (missing,
        // installed-but-unlaunchable, or blocked by security software). Creates a
        // diagnostic panel instead of a failed PTY spawn. `unauthenticated` is
        // launchable — the CLI handles first-run auth itself.
        if (isAgent && !launchOptions?.force) {
          const launchCliDetail = await getCurrentLaunchCliDetail(agentId);
          if (launchCliDetail && !isAgentLaunchable(launchCliDetail.state)) {
            const gateId = `terminal-${crypto.randomUUID()}`;
            const gatePanel: TerminalInstance = {
              id: gateId,
              kind: "terminal",
              launchAgentId: agentId,
              title: presetTitle,
              worktreeId: targetWorktreeId || undefined,
              cwd,
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
            };
            usePanelStore.setState((state) => {
              const next: Partial<typeof state> = {
                panelsById: { ...state.panelsById, [gateId]: gatePanel },
                panelIds: [...state.panelIds, gateId],
              };
              // Atomic dock activation — same race fix as `addPanel`. The gate
              // panel bypasses `addPanel`, so the activation must be folded
              // into this `set()` directly. See #6590.
              if (launchOptions?.activateDockOnCreate && launchOptions?.location === "dock") {
                const prevFocusedId = state.focusedId ?? null;
                const focusActuallyChanged = gateId !== prevFocusedId;
                next.activeDockTerminalId = gateId;
                next.focusedId = gateId;
                if (focusActuallyChanged) {
                  next.previousFocusedId = prevFocusedId;
                }
              }
              return next;
            });
            return gateId;
          }
        }

        try {
          const terminalId = await addPanel(options);
          return terminalId;
        } catch (error) {
          logError(`Failed to launch ${agentId} agent`, error);
          return null;
        }
      } finally {
        launchingAgentsRef.current.delete(agentId);
      }
    },
    [activeWorktreeId, worktreeMap, isInitialized, addPanel, currentProject, agentSettings, homeDir]
  );

  return {
    launchAgent,
    availability,
    isCheckingAvailability: isLoading || isRefreshing,
    agentSettings,
    refreshSettings: checkAvailabilityAndLoadSettings,
  };
}
