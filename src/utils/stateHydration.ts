import { appClient, terminalClient, worktreeClient, projectClient } from "@/clients";
import { terminalConfigClient } from "@/clients/terminalConfigClient";
import {
  useLayoutConfigStore,
  useScrollbackStore,
  usePerformanceModeStore,
  useTerminalInputStore,
} from "@/store";
import { useUserAgentRegistryStore } from "@/store/userAgentRegistryStore";
import type {
  TerminalType,
  AgentState,
  TerminalKind,
  TerminalReconnectError,
  TabGroup,
} from "@/types";
import { keybindingService } from "@/services/KeybindingService";
import { getAgentConfig, isRegisteredAgent } from "@/config/agents";
import { generateAgentFlags } from "@shared/types";
import { normalizeScrollbackLines } from "@shared/config/scrollback";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { panelKindHasPty } from "@shared/config/panelKindRegistry";
import { logDebug, logInfo, logWarn, logError } from "@/utils/logger";

const RECONNECT_TIMEOUT_MS = 10000;

export interface HydrationOptions {
  addTerminal: (options: {
    kind?: TerminalKind;
    type?: TerminalType;
    agentId?: string;
    title?: string;
    cwd: string;
    worktreeId?: string;
    location?: "grid" | "dock";
    command?: string;
    agentState?: AgentState;
    lastStateChange?: number;
    existingId?: string; // Pass to reconnect to existing backend process
    requestedId?: string; // Pass to spawn with a stable ID
    skipCommandExecution?: boolean; // Store command but don't execute on spawn
    isInputLocked?: boolean; // Restore input lock state
    browserUrl?: string; // URL for browser panes
    notePath?: string; // Path to note file (kind === 'notes')
    noteId?: string; // Note ID (kind === 'notes')
    scope?: "worktree" | "project"; // Note scope (kind === 'notes')
    createdAt?: number; // Note creation timestamp (kind === 'notes')
    devCommand?: string; // Dev command override for dev-preview panels
  }) => Promise<string>;
  setActiveWorktree: (id: string | null) => void;
  loadRecipes: (projectId: string) => Promise<void>;
  openDiagnosticsDock: (tab?: "problems" | "logs" | "events") => void;
  setFocusMode?: (
    focusMode: boolean,
    focusPanelState?: { sidebarWidth: number; diagnosticsOpen: boolean }
  ) => void;
  setReconnectError?: (id: string, error: TerminalReconnectError) => void;
  hydrateTabGroups?: (tabGroups: TabGroup[], options?: { skipPersist?: boolean }) => void;
}

export async function hydrateAppState(
  options: HydrationOptions,
  _switchId?: string,
  isCurrent?: () => boolean
): Promise<void> {
  const { addTerminal, setActiveWorktree, loadRecipes, openDiagnosticsDock } = options;

  // Helper to check if this hydration is still current (not superseded by newer switch)
  const checkCurrent = (): boolean => {
    if (!isCurrent) return true;
    return isCurrent();
  };

  try {
    await keybindingService.loadOverrides();
    if (!checkCurrent()) return;

    // Initialize user agent registry for existing user-defined agents
    // (no UI exposure, but allows existing agents to function)
    await useUserAgentRegistryStore.getState().initialize();
    if (!checkCurrent()) return;

    // Batch fetch initial state
    const {
      appState,
      terminalConfig,
      project: currentProject,
      agentSettings,
    } = await appClient.hydrate();
    if (!checkCurrent()) return;

    // Hydrate terminal config (scrollback, performance mode) BEFORE restoring terminals
    try {
      if (terminalConfig?.scrollbackLines !== undefined) {
        const { scrollbackLines } = terminalConfig;
        const normalizedScrollback = normalizeScrollbackLines(scrollbackLines);

        if (normalizedScrollback !== scrollbackLines) {
          logInfo(`Normalizing scrollback from ${scrollbackLines} to ${normalizedScrollback}`);
          terminalConfigClient.setScrollback(normalizedScrollback).catch((err) => {
            logWarn("Failed to persist scrollback normalization", { error: err });
          });
        }

        useScrollbackStore.getState().setScrollbackLines(normalizedScrollback);
      }
      if (terminalConfig?.performanceMode !== undefined) {
        usePerformanceModeStore.getState().setPerformanceMode(terminalConfig.performanceMode);
      }
      if (terminalConfig) {
        useTerminalInputStore
          .getState()
          .setHybridInputEnabled(terminalConfig.hybridInputEnabled ?? true);
        useTerminalInputStore
          .getState()
          .setHybridInputAutoFocus(terminalConfig.hybridInputAutoFocus ?? true);
      }
    } catch (error) {
      logWarn("Failed to hydrate terminal config", { error });
    }

    if (!appState) {
      logWarn("App state returned undefined during hydration, using defaults");
      return;
    }

    // Discover running terminals from the backend
    // Terminals stay running across project switches - we just reconnect to them
    const currentProjectId = currentProject?.id;
    const projectRoot = currentProject?.path;

    if (currentProjectId) {
      try {
        const backendTerminals = await terminalClient.getForProject(currentProjectId);
        if (!checkCurrent()) return;

        logInfo(
          `Found ${backendTerminals.length} running terminals for project ${currentProjectId}`
        );

        if (
          typeof process !== "undefined" &&
          typeof process.env !== "undefined" &&
          process.env.CANOPY_VERBOSE === "1"
        ) {
          logDebug(`Project: ${currentProjectId.slice(0, 8)}`);
          logDebug("Backend terminals", {
            terminals: backendTerminals.map((t) => ({
              id: t.id.slice(0, 8),
              kind: t.kind,
              agentId: t.agentId,
              projectId: t.projectId?.slice(0, 8),
            })),
          });
        }

        // Build a map of backend terminals by ID for quick lookup
        const backendTerminalMap = new Map(backendTerminals.map((t) => [t.id, t]));

        // Restore all panels in saved order (mix of PTY reconnects and non-PTY recreations)
        if (appState.terminals && appState.terminals.length > 0) {
          logInfo(`Restoring ${appState.terminals.length} saved panel(s)`);

          for (const saved of appState.terminals) {
            try {
              const backendTerminal = backendTerminalMap.get(saved.id);

              if (backendTerminal) {
                // PTY terminal - reconnect to existing backend process
                logInfo(`Reconnecting to terminal: ${saved.id}`);

                const cwd = backendTerminal.cwd || projectRoot || "";
                const currentAgentState = backendTerminal.agentState;
                const backendLastStateChange = backendTerminal.lastStateChange;
                let agentId =
                  backendTerminal.agentId ??
                  (backendTerminal.type && isRegisteredAgent(backendTerminal.type)
                    ? backendTerminal.type
                    : undefined);

                // If kind is "agent" but agentId is missing, try to infer from title
                // Only set a default if we can confidently match, otherwise leave undefined
                if (!agentId && backendTerminal.kind === "agent") {
                  const titleLower = (backendTerminal.title ?? "").toLowerCase();
                  if (titleLower.includes("claude")) {
                    agentId = "claude";
                  } else if (titleLower.includes("gemini")) {
                    agentId = "gemini";
                  } else if (titleLower.includes("codex")) {
                    agentId = "codex";
                  } else if (titleLower.includes("opencode")) {
                    agentId = "opencode";
                  } else {
                    // Don't force a default - leave undefined if we can't match
                    logWarn(
                      `Backend agent terminal ${backendTerminal.id} missing agentId and title doesn't match known agents: "${backendTerminal.title}"`
                    );
                  }
                }

                const location = (saved.location === "dock" ? "dock" : "grid") as "grid" | "dock";

                logInfo(`[HYDRATION] Adding terminal from backend:`, {
                  id: backendTerminal.id,
                  kind: backendTerminal.kind ?? (agentId ? "agent" : "terminal"),
                  agentId,
                  location,
                  worktreeId: backendTerminal.worktreeId,
                  title: backendTerminal.title,
                });

                await addTerminal({
                  kind: backendTerminal.kind ?? (agentId ? "agent" : "terminal"),
                  type: backendTerminal.type,
                  agentId,
                  title: backendTerminal.title,
                  cwd,
                  worktreeId: backendTerminal.worktreeId,
                  location,
                  existingId: backendTerminal.id,
                  agentState: currentAgentState,
                  lastStateChange: backendLastStateChange,
                });

                // Initialize frontend tier state from backend to ensure proper wake behavior
                // after project switch. Without this, frontend defaults to "active" which prevents
                // proper wake when transitioning from background to active tier.
                if (backendTerminal.activityTier) {
                  terminalInstanceService.initializeBackendTier(
                    backendTerminal.id,
                    backendTerminal.activityTier
                  );
                }

                // Restore terminal content from backend headless state
                try {
                  await terminalInstanceService.fetchAndRestore(backendTerminal.id);
                } catch (snapshotError) {
                  logWarn(`Serialized state restore failed for ${saved.id}`, {
                    error: snapshotError,
                  });
                }

                // Mark as restored
                backendTerminalMap.delete(saved.id);
              } else {
                // Non-PTY panel or PTY panel that no longer exists in backend - try to recreate
                // Infer kind from panel properties if missing (defense-in-depth for legacy data)
                // Note: TerminalSnapshot uses 'command' field for both regular terminals and dev-preview.
                // Without 'kind', we can't distinguish them, so we default to 'terminal'.
                let kind: TerminalKind = saved.kind ?? "terminal";
                if (!saved.kind) {
                  if (saved.browserUrl !== undefined) {
                    kind = "browser";
                  } else if (saved.notePath !== undefined || saved.noteId !== undefined) {
                    kind = "notes";
                  } else if (saved.title === "Assistant" || saved.title?.startsWith("Assistant")) {
                    // Legacy assistant panels from before kind was always set - skip these
                    // Match "Assistant", "Assistant (renamed)", etc.
                    kind = "assistant";
                  } else if (!saved.cwd && !saved.command) {
                    // Non-PTY panel with no PTY markers and not browser/notes - likely legacy assistant
                    kind = "assistant";
                  }
                  // Note: dev-preview detection removed since 'devCommand' isn't in TerminalSnapshot.
                  // Dev-preview panels should always have 'kind' set during persistence.
                }

                // Skip assistant panels (they're now global, not panel-based)
                if (kind === "assistant") {
                  console.log(`[StateHydration] Skipping legacy assistant panel: ${saved.id}`);
                  continue;
                }

                const location = (saved.location === "dock" ? "dock" : "grid") as "grid" | "dock";

                if (panelKindHasPty(kind)) {
                  // RECONNECT FALLBACK: Before respawning, try to reconnect directly by ID.
                  // This handles cases where getForProject missed the terminal due to project
                  // ID mismatch or stale project association. The terminal may still be running
                  // in the backend but wasn't returned by getForProject.
                  // Uses panelKindHasPty to include dev-preview panels which have PTY processes.
                  let reconnectedTerminal: Awaited<
                    ReturnType<typeof terminalClient.reconnect>
                  > | null = null;
                  let reconnectTimedOut = false;

                  try {
                    // Always log reconnect attempts to help diagnose project switch issues
                    logInfo(`Trying reconnect fallback for ${saved.id} (kind: ${kind})`);

                    // Race reconnect against timeout to prevent indefinite waiting
                    const reconnectPromise = terminalClient.reconnect(saved.id);
                    const timeoutPromise = new Promise<null>((_, reject) =>
                      setTimeout(
                        () => reject(new Error("Reconnection timeout")),
                        RECONNECT_TIMEOUT_MS
                      )
                    );

                    reconnectedTerminal = await Promise.race([reconnectPromise, timeoutPromise]);

                    if (reconnectedTerminal?.exists && reconnectedTerminal.hasPty) {
                      logInfo(
                        `Reconnect fallback succeeded for ${saved.id} - terminal exists in backend but was missed by getForProject`
                      );
                    } else {
                      logInfo(
                        `Reconnect fallback: terminal ${saved.id} not found (exists=${reconnectedTerminal?.exists}, hasPty=${reconnectedTerminal?.hasPty})`
                      );
                    }
                  } catch (reconnectError) {
                    const isTimeout =
                      reconnectError instanceof Error &&
                      reconnectError.message === "Reconnection timeout";
                    reconnectTimedOut = isTimeout;

                    if (isTimeout) {
                      logWarn(
                        `Reconnect timed out for ${saved.id} after ${RECONNECT_TIMEOUT_MS}ms`
                      );
                    } else {
                      logWarn(`Reconnect fallback failed for ${saved.id}`, {
                        error: reconnectError,
                      });
                    }
                    reconnectedTerminal = null;
                  }

                  if (reconnectedTerminal?.exists && reconnectedTerminal.hasPty) {
                    // Terminal exists in backend - reconnect instead of respawning
                    const cwd = reconnectedTerminal.cwd || saved.cwd || projectRoot || "";
                    const currentAgentState = reconnectedTerminal.agentState;
                    const backendLastStateChange = reconnectedTerminal.lastStateChange;
                    let agentId =
                      reconnectedTerminal.agentId ??
                      saved.agentId ??
                      (reconnectedTerminal.type && isRegisteredAgent(reconnectedTerminal.type)
                        ? reconnectedTerminal.type
                        : saved.type && isRegisteredAgent(saved.type)
                          ? saved.type
                          : undefined);

                    // If kind is "agent" but agentId is missing, try to infer from title
                    // Only set if we can confidently match, otherwise leave undefined
                    const reconnectedKind = reconnectedTerminal.kind ?? saved.kind;
                    if (!agentId && reconnectedKind === "agent") {
                      const title = reconnectedTerminal.title ?? saved.title ?? "";
                      const titleLower = title.toLowerCase();
                      if (titleLower.includes("claude")) {
                        agentId = "claude";
                      } else if (titleLower.includes("gemini")) {
                        agentId = "gemini";
                      } else if (titleLower.includes("codex")) {
                        agentId = "codex";
                      } else if (titleLower.includes("opencode")) {
                        agentId = "opencode";
                      } else {
                        // Don't force a default - leave undefined if we can't match
                        logWarn(
                          `Reconnected agent panel ${saved.id} missing agentId and title doesn't match known agents: "${title}"`
                        );
                      }
                    }

                    await addTerminal({
                      kind: reconnectedKind ?? (agentId ? "agent" : "terminal"),
                      type: reconnectedTerminal.type ?? saved.type,
                      agentId,
                      title: reconnectedTerminal.title ?? saved.title,
                      cwd,
                      worktreeId: reconnectedTerminal.worktreeId ?? saved.worktreeId,
                      location,
                      existingId: reconnectedTerminal.id,
                      agentState: currentAgentState,
                      lastStateChange: backendLastStateChange,
                    });

                    // Initialize frontend tier state from backend
                    if (reconnectedTerminal.activityTier) {
                      terminalInstanceService.initializeBackendTier(
                        reconnectedTerminal.id!,
                        reconnectedTerminal.activityTier
                      );
                    }

                    // Restore terminal content from backend headless state
                    try {
                      await terminalInstanceService.fetchAndRestore(reconnectedTerminal.id!);
                    } catch (snapshotError) {
                      logWarn(`Serialized state restore failed for ${saved.id}`, {
                        error: snapshotError,
                      });
                    }
                  } else {
                    // Terminal doesn't exist in backend or timed out - respawn
                    let effectiveAgentId =
                      saved.agentId ??
                      (saved.type && isRegisteredAgent(saved.type) ? saved.type : undefined);

                    // If kind is "agent" but we couldn't determine agentId, try to infer from title
                    // This handles cases where agentId wasn't persisted (legacy data or bug)
                    // WARNING: For respawn path, only set agentId if we can confidently match
                    // Otherwise we'll regenerate the wrong command
                    if (!effectiveAgentId && kind === "agent") {
                      const titleLower = (saved.title ?? "").toLowerCase();
                      if (titleLower.includes("claude")) {
                        effectiveAgentId = "claude";
                      } else if (titleLower.includes("gemini")) {
                        effectiveAgentId = "gemini";
                      } else if (titleLower.includes("codex")) {
                        effectiveAgentId = "codex";
                      } else if (titleLower.includes("opencode")) {
                        effectiveAgentId = "opencode";
                      } else {
                        // Don't force a default for respawn - we'll generate wrong command
                        // Keep kind as "terminal" instead
                        logWarn(
                          `Agent panel ${saved.id} missing agentId and title doesn't match known agents: "${saved.title}" - respawning as terminal`
                        );
                      }
                    }

                    const isAgentPanel = kind === "agent" || Boolean(effectiveAgentId);
                    const agentId = effectiveAgentId;
                    let command = saved.command?.trim() || undefined;

                    if (agentId && agentSettings) {
                      const agentConfig = getAgentConfig(agentId);
                      const baseCommand = agentConfig?.command || agentId;
                      const flags = generateAgentFlags(
                        agentSettings.agents?.[agentId] ?? {},
                        agentId
                      );
                      command =
                        flags.length > 0 ? `${baseCommand} ${flags.join(" ")}` : baseCommand;
                    }

                    // Preserve the original kind (dev-preview, terminal, etc.) unless it's an agent
                    const respawnKind = isAgentPanel ? "agent" : kind;
                    const isDevPreview = kind === "dev-preview";

                    // Silently spawn a fresh session for all terminal types
                    // No error messages - just start fresh
                    logInfo(
                      `Respawning PTY panel: ${saved.id} (${isAgentPanel ? "agent" : "terminal"})`
                    );

                    logInfo(`[HYDRATION-RESPAWN] Adding terminal:`, {
                      id: saved.id,
                      kind: respawnKind,
                      agentId,
                      location,
                      savedLocation: saved.location,
                      worktreeId: saved.worktreeId,
                      title: saved.title,
                    });

                    await addTerminal({
                      kind: respawnKind,
                      type: saved.type,
                      agentId,
                      title: saved.title,
                      cwd: saved.cwd || projectRoot || "",
                      worktreeId: saved.worktreeId,
                      location,
                      // Don't reuse ID on timeout - could kill a slow-to-respond live session
                      requestedId: reconnectTimedOut ? undefined : saved.id,
                      command: isAgentPanel ? command : undefined,
                      // Execute command at spawn for all agents (grid and dock)
                      // Docked agents just run in background - same behavior, different location
                      isInputLocked: saved.isInputLocked,
                      devCommand: isDevPreview ? command : undefined,
                      browserUrl: isDevPreview ? saved.browserUrl : undefined,
                    });
                  }
                } else {
                  logInfo(`Recreating ${kind} panel: ${saved.id}`);

                  const devCommandCandidate =
                    kind === "dev-preview" ? saved.devCommand?.trim() : undefined;
                  const devCommand =
                    kind === "dev-preview"
                      ? devCommandCandidate || saved.command?.trim() || undefined
                      : undefined;

                  await addTerminal({
                    kind,
                    title: saved.title,
                    cwd: saved.cwd || projectRoot || "",
                    worktreeId: saved.worktreeId,
                    location,
                    requestedId: saved.id,
                    browserUrl: saved.browserUrl,
                    notePath: saved.notePath,
                    noteId: saved.noteId,
                    scope: saved.scope as "worktree" | "project" | undefined,
                    createdAt: saved.createdAt,
                    devCommand,
                  });
                }
              }
            } catch (error) {
              logWarn(`Failed to restore panel ${saved.id}`, { error });
            }
          }
        }

        // Restore any orphaned backend terminals not in saved state (append at end)
        const orphanedTerminals = Array.from(backendTerminalMap.values());
        if (orphanedTerminals.length > 0) {
          logInfo(
            `${orphanedTerminals.length} orphaned terminal(s) not in saved order, appending at end`
          );

          for (const terminal of orphanedTerminals) {
            try {
              logInfo(`Reconnecting to orphaned terminal: ${terminal.id}`);

              const cwd = terminal.cwd || projectRoot || "";
              const currentAgentState = terminal.agentState;
              const backendLastStateChange = terminal.lastStateChange;
              let agentId =
                terminal.agentId ??
                (terminal.type && isRegisteredAgent(terminal.type) ? terminal.type : undefined);

              // If kind is "agent" but agentId is missing, try to infer from title
              // Only set if we can confidently match, otherwise leave undefined
              if (!agentId && terminal.kind === "agent") {
                const titleLower = (terminal.title ?? "").toLowerCase();
                if (titleLower.includes("claude")) {
                  agentId = "claude";
                } else if (titleLower.includes("gemini")) {
                  agentId = "gemini";
                } else if (titleLower.includes("codex")) {
                  agentId = "codex";
                } else if (titleLower.includes("opencode")) {
                  agentId = "opencode";
                } else {
                  // Don't force a default - leave undefined if we can't match
                  logWarn(
                    `Orphaned agent terminal ${terminal.id} missing agentId and title doesn't match known agents: "${terminal.title}"`
                  );
                }
              }

              await addTerminal({
                kind: terminal.kind ?? (agentId ? "agent" : "terminal"),
                type: terminal.type,
                agentId,
                title: terminal.title,
                cwd,
                worktreeId: terminal.worktreeId,
                location: "grid",
                existingId: terminal.id,
                agentState: currentAgentState,
                lastStateChange: backendLastStateChange,
              });

              // Initialize frontend tier state from backend to ensure proper wake behavior
              if (terminal.activityTier) {
                terminalInstanceService.initializeBackendTier(terminal.id, terminal.activityTier);
              }

              // Restore terminal content from backend headless state
              try {
                await terminalInstanceService.fetchAndRestore(terminal.id);
              } catch (snapshotError) {
                logWarn(`Serialized state restore failed for ${terminal.id}`, {
                  error: snapshotError,
                });
              }
            } catch (error) {
              logWarn(`Failed to reconnect to orphaned terminal ${terminal.id}`, { error });
            }
          }
        }
      } catch (error) {
        logWarn("Failed to query backend terminals", { error });
      }

      // Restore tab groups after terminals are restored
      if (options.hydrateTabGroups) {
        try {
          const tabGroups = await projectClient.getTabGroups(currentProjectId);
          if (!checkCurrent()) return;

          // Always call hydrateTabGroups, even with empty array, to clear stale groups
          if (tabGroups && tabGroups.length > 0) {
            logInfo(`Restoring ${tabGroups.length} tab group(s)`);
          } else {
            logInfo("Clearing stale tab groups (no groups for project)");
          }
          options.hydrateTabGroups(tabGroups ?? []);
        } catch (error) {
          logWarn("Failed to restore tab groups", { error });
          // Check staleness before clearing to prevent race condition
          if (!checkCurrent()) return;
          // Clear tab groups on error to prevent stale state, but skip persist to avoid wiping storage
          options.hydrateTabGroups([], { skipPersist: true });
        }
      }
    }

    // Cleanup orphaned terminals after terminal hydration completes
    // This must run after terminals are restored to ensure we're checking the full terminal list
    try {
      const { cleanupOrphanedTerminals } = await import("@/store/worktreeDataStore");
      cleanupOrphanedTerminals();
    } catch (error) {
      logWarn("Failed to cleanup orphaned terminals", { error });
    }

    // Restore active worktree with validation
    // Fetch worktrees to validate the saved activeWorktreeId still exists
    try {
      const worktrees = await worktreeClient.getAll();
      const savedActiveId = appState.activeWorktreeId;

      if (worktrees.length > 0) {
        // Check if the saved active worktree still exists
        const worktreeExists = savedActiveId && worktrees.some((wt) => wt.id === savedActiveId);

        if (worktreeExists) {
          // Restore the saved active worktree
          setActiveWorktree(savedActiveId);
        } else {
          // Fallback to the first worktree (main worktree is typically first)
          const sortedWorktrees = [...worktrees].sort((a, b) => {
            if (a.isMainWorktree && !b.isMainWorktree) return -1;
            if (!a.isMainWorktree && b.isMainWorktree) return 1;
            return a.name.localeCompare(b.name);
          });
          const fallbackWorktree = sortedWorktrees[0];
          logInfo(
            `Active worktree ${savedActiveId ?? "(none)"} not found, falling back to: ${fallbackWorktree.name}`
          );
          setActiveWorktree(fallbackWorktree.id);
        }
      }
      // If no worktrees exist, we don't set any active worktree (handled gracefully)
    } catch (error) {
      logWarn("Failed to validate active worktree", { error });
      // On error, still try to use the saved ID if present
      if (appState.activeWorktreeId) {
        setActiveWorktree(appState.activeWorktreeId);
      }
    }

    // Load recipes for the current project
    if (currentProjectId) {
      await loadRecipes(currentProjectId);
    }

    if (appState.developerMode?.enabled && appState.developerMode.autoOpenDiagnostics) {
      const tab = appState.developerMode.focusEventsTab ? "events" : undefined;
      openDiagnosticsDock(tab);
    }

    // Migration: read from new key, fallback to old key for backward compatibility
    const layoutConfig =
      appState.panelGridConfig ??
      (appState as unknown as { terminalGridConfig?: typeof appState.panelGridConfig })
        .terminalGridConfig;
    if (layoutConfig) {
      useLayoutConfigStore.getState().setLayoutConfig(layoutConfig);
    }

    // Restore focus mode from per-project state (hydrate returns per-project focus mode)
    if (options.setFocusMode && appState.focusMode !== undefined) {
      options.setFocusMode(appState.focusMode, appState.focusPanelState);
    }
  } catch (error) {
    logError("Failed to hydrate app state", error);
    throw error;
  }
}
