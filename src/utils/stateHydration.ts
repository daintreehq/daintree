import { appClient, terminalClient, worktreeClient } from "@/clients";
import { terminalConfigClient } from "@/clients/terminalConfigClient";
import {
  useLayoutConfigStore,
  useScrollbackStore,
  usePerformanceModeStore,
  useTerminalInputStore,
} from "@/store";
import { useUserAgentRegistryStore } from "@/store/userAgentRegistryStore";
import type { TerminalType, AgentState, TerminalKind } from "@/types";
import { keybindingService } from "@/services/KeybindingService";
import { getAgentConfig, isRegisteredAgent } from "@/config/agents";
import { generateAgentFlags } from "@shared/types";
import { normalizeScrollbackLines } from "@shared/config/scrollback";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { panelKindHasPty } from "@shared/config/panelKindRegistry";

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
}

export async function hydrateAppState(options: HydrationOptions): Promise<void> {
  const { addTerminal, setActiveWorktree, loadRecipes, openDiagnosticsDock } = options;

  try {
    await keybindingService.loadOverrides();

    // Initialize user agent registry for existing user-defined agents
    // (no UI exposure, but allows existing agents to function)
    await useUserAgentRegistryStore.getState().initialize();

    // Batch fetch initial state
    const {
      appState,
      terminalConfig,
      project: currentProject,
      agentSettings,
    } = await appClient.hydrate();

    // Hydrate terminal config (scrollback, performance mode) BEFORE restoring terminals
    try {
      if (terminalConfig?.scrollbackLines !== undefined) {
        const { scrollbackLines } = terminalConfig;
        const normalizedScrollback = normalizeScrollbackLines(scrollbackLines);

        if (normalizedScrollback !== scrollbackLines) {
          console.log(
            `[Hydration] Normalizing scrollback from ${scrollbackLines} to ${normalizedScrollback}`
          );
          terminalConfigClient.setScrollback(normalizedScrollback).catch((err) => {
            console.warn("[Hydration] Failed to persist scrollback normalization:", err);
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
      console.warn("Failed to hydrate terminal config:", error);
    }

    if (!appState) {
      console.warn("App state returned undefined during hydration, using defaults");
      return;
    }

    // Discover running terminals from the backend
    // Terminals stay running across project switches - we just reconnect to them
    const currentProjectId = currentProject?.id;
    const projectRoot = currentProject?.path;

    if (currentProjectId) {
      try {
        const backendTerminals = await terminalClient.getForProject(currentProjectId);
        console.log(
          `[Hydration] Found ${backendTerminals.length} running terminals for project ${currentProjectId}`
        );

        if (
          typeof process !== "undefined" &&
          typeof process.env !== "undefined" &&
          process.env.CANOPY_VERBOSE === "1"
        ) {
          console.log("[Hydration] Project:", currentProjectId.slice(0, 8));
          console.log(
            "[Hydration] Backend terminals:",
            JSON.stringify(
              backendTerminals.map((t) => ({
                id: t.id.slice(0, 8),
                kind: t.kind,
                agentId: t.agentId,
                projectId: t.projectId?.slice(0, 8),
              })),
              null,
              2
            )
          );
        }

        // Build a map of backend terminals by ID for quick lookup
        const backendTerminalMap = new Map(backendTerminals.map((t) => [t.id, t]));

        // Restore all panels in saved order (mix of PTY reconnects and non-PTY recreations)
        if (appState.terminals && appState.terminals.length > 0) {
          console.log(`[Hydration] Restoring ${appState.terminals.length} saved panel(s)`);

          for (const saved of appState.terminals) {
            try {
              const backendTerminal = backendTerminalMap.get(saved.id);

              if (backendTerminal) {
                // PTY terminal - reconnect to existing backend process
                console.log(`[Hydration] Reconnecting to terminal: ${saved.id}`);

                const cwd = backendTerminal.cwd || projectRoot || "";
                const currentAgentState = backendTerminal.agentState;
                const backendLastStateChange = backendTerminal.lastStateChange;
                const agentId =
                  backendTerminal.agentId ??
                  (backendTerminal.type && isRegisteredAgent(backendTerminal.type)
                    ? backendTerminal.type
                    : undefined);

                const location = (saved.location === "dock" ? "dock" : "grid") as "grid" | "dock";

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
                  console.warn(
                    `[Hydration] Serialized state restore failed for ${saved.id}:`,
                    snapshotError
                  );
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
                  }
                  // Note: dev-preview detection removed since 'devCommand' isn't in TerminalSnapshot.
                  // Dev-preview panels should always have 'kind' set during persistence.
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

                  try {
                    // Always log reconnect attempts to help diagnose project switch issues
                    console.log(
                      `[Hydration] Trying reconnect fallback for ${saved.id} (kind: ${kind})`
                    );
                    reconnectedTerminal = await terminalClient.reconnect(saved.id);
                    if (reconnectedTerminal?.exists && reconnectedTerminal.hasPty) {
                      console.log(
                        `[Hydration] Reconnect fallback succeeded for ${saved.id} - terminal exists in backend but was missed by getForProject`
                      );
                    } else {
                      console.log(
                        `[Hydration] Reconnect fallback: terminal ${saved.id} not found (exists=${reconnectedTerminal?.exists}, hasPty=${reconnectedTerminal?.hasPty})`
                      );
                    }
                  } catch (reconnectError) {
                    console.warn(
                      `[Hydration] Reconnect fallback failed for ${saved.id}:`,
                      reconnectError
                    );
                    reconnectedTerminal = null;
                  }

                  if (reconnectedTerminal?.exists && reconnectedTerminal.hasPty) {
                    // Terminal exists in backend - reconnect instead of respawning
                    const cwd = reconnectedTerminal.cwd || saved.cwd || projectRoot || "";
                    const currentAgentState = reconnectedTerminal.agentState;
                    const backendLastStateChange = reconnectedTerminal.lastStateChange;
                    const agentId =
                      reconnectedTerminal.agentId ??
                      saved.agentId ??
                      (reconnectedTerminal.type && isRegisteredAgent(reconnectedTerminal.type)
                        ? reconnectedTerminal.type
                        : saved.type && isRegisteredAgent(saved.type)
                          ? saved.type
                          : undefined);

                    await addTerminal({
                      kind: reconnectedTerminal.kind ?? (agentId ? "agent" : "terminal"),
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
                      console.warn(
                        `[Hydration] Serialized state restore failed for ${saved.id}:`,
                        snapshotError
                      );
                    }
                  } else {
                    // Terminal truly doesn't exist in backend - respawn
                    const effectiveAgentId =
                      saved.agentId ??
                      (saved.type && isRegisteredAgent(saved.type) ? saved.type : undefined);
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

                    console.log(`[Hydration] Respawning PTY panel: ${saved.id}`);

                    // Preserve the original kind (dev-preview, terminal, etc.) unless it's an agent
                    const respawnKind = isAgentPanel ? "agent" : kind;
                    const isDevPreview = kind === "dev-preview";
                    
                    await addTerminal({
                      kind: respawnKind,
                      type: saved.type,
                      agentId,
                      title: saved.title,
                      cwd: saved.cwd || projectRoot || "",
                      worktreeId: saved.worktreeId,
                      location,
                      requestedId: saved.id,
                      command,
                      isInputLocked: saved.isInputLocked,
                      devCommand: isDevPreview ? command : undefined,
                      browserUrl: isDevPreview ? saved.browserUrl : undefined,
                    });
                  }
                } else {
                  console.log(`[Hydration] Recreating ${kind} panel: ${saved.id}`);

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
              console.warn(`Failed to restore panel ${saved.id}:`, error);
            }
          }
        }

        // Restore any orphaned backend terminals not in saved state (append at end)
        const orphanedTerminals = Array.from(backendTerminalMap.values());
        if (orphanedTerminals.length > 0) {
          console.log(
            `[Hydration] ${orphanedTerminals.length} orphaned terminal(s) not in saved order, appending at end`
          );

          for (const terminal of orphanedTerminals) {
            try {
              console.log(`[Hydration] Reconnecting to orphaned terminal: ${terminal.id}`);

              const cwd = terminal.cwd || projectRoot || "";
              const currentAgentState = terminal.agentState;
              const backendLastStateChange = terminal.lastStateChange;
              const agentId =
                terminal.agentId ??
                (terminal.type && isRegisteredAgent(terminal.type) ? terminal.type : undefined);

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
                console.warn(
                  `[Hydration] Serialized state restore failed for ${terminal.id}:`,
                  snapshotError
                );
              }
            } catch (error) {
              console.warn(`Failed to reconnect to orphaned terminal ${terminal.id}:`, error);
            }
          }
        }
      } catch (error) {
        console.warn("Failed to query backend terminals:", error);
      }
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
          console.log(
            `[Hydration] Active worktree ${savedActiveId ?? "(none)"} not found, falling back to: ${fallbackWorktree.name}`
          );
          setActiveWorktree(fallbackWorktree.id);
        }
      }
      // If no worktrees exist, we don't set any active worktree (handled gracefully)
    } catch (error) {
      console.warn("[Hydration] Failed to validate active worktree:", error);
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
    console.error("Failed to hydrate app state:", error);
    throw error;
  }
}
