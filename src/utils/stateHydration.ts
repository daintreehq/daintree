import { appClient, terminalClient } from "@/clients";
import { terminalConfigClient } from "@/clients/terminalConfigClient";
import { useLayoutConfigStore, useScrollbackStore, usePerformanceModeStore } from "@/store";
import type { TerminalType, TerminalState, AgentState, TerminalKind } from "@/types";
import { generateAgentFlags, type AgentSettings } from "@shared/types";
import { keybindingService } from "@/services/KeybindingService";
import { isRegisteredAgent, getAgentConfig } from "@/config/agents";
import { normalizeScrollbackLines } from "@shared/config/scrollback";

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
    skipCommandExecution?: boolean; // Store command but don't execute on spawn
  }) => Promise<string>;
  setActiveWorktree: (id: string | null) => void;
  loadRecipes: () => Promise<void>;
  openDiagnosticsDock: (tab?: "problems" | "logs" | "events") => void;
}

export async function hydrateAppState(options: HydrationOptions): Promise<void> {
  const { addTerminal, setActiveWorktree, loadRecipes, openDiagnosticsDock } = options;

  try {
    await keybindingService.loadOverrides();

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
    } catch (error) {
      console.warn("Failed to hydrate terminal config:", error);
    }

    if (!appState) {
      console.warn("App state returned undefined during hydration, using defaults");
      return;
    }

    if (appState.terminals && appState.terminals.length > 0) {
      const projectRoot = currentProject?.path;
      const currentProjectId = currentProject?.id;

      // Query backend for existing terminals in this project
      let backendTerminalIds = new Set<string>();
      if (currentProjectId) {
        try {
          const backendTerminals = await terminalClient.getForProject(currentProjectId);
          backendTerminalIds = new Set(backendTerminals.map((t) => t.id));
          console.log(`[Hydration] Found ${backendTerminalIds.size} existing terminals in backend`);
        } catch (error) {
          console.warn("Failed to query backend terminals:", error);
        }
      }

      for (const terminal of appState.terminals) {
        try {
          if (terminal.id === "default") continue;

          const cwd = terminal.cwd || projectRoot || "";

          // Check if backend already has this terminal (from Phase 1 process preservation)
          if (backendTerminalIds.has(terminal.id)) {
            console.log(`[Hydration] Reconnecting to existing terminal: ${terminal.id}`);

            // Verify terminal still exists and get current state
            let reconnectResult;
            try {
              reconnectResult = await terminalClient.reconnect(terminal.id);
            } catch (reconnectError) {
              console.warn(`[Hydration] Reconnect failed for ${terminal.id}:`, reconnectError);
              await spawnNewTerminal(terminal, cwd, addTerminal, agentSettings);
              continue;
            }

            if (reconnectResult.exists) {
              // Add to UI without spawning new process, preserving agent state and command
              const currentAgentState = reconnectResult.agentState as AgentState | undefined;
              // Get effective agentId - handles migration from type-based to agentId-based system
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
                location: terminal.location === "dock" ? "dock" : "grid",
                command: terminal.command, // Preserve for manual refresh
                existingId: terminal.id, // Flag to skip spawning
                agentState: currentAgentState,
                lastStateChange: currentAgentState ? Date.now() : undefined,
              });

              // Request history replay for seamless restoration
              try {
                const { replayed } = await terminalClient.replayHistory(terminal.id, 100);
                console.log(`[Hydration] Replayed ${replayed} lines for terminal ${terminal.id}`);
              } catch (replayError) {
                console.warn(`[Hydration] History replay failed for ${terminal.id}:`, replayError);
              }
            } else {
              // Backend lost this terminal - spawn new
              console.warn(
                `[Hydration] Terminal ${terminal.id} not found in backend, spawning new`
              );
              await spawnNewTerminal(terminal, cwd, addTerminal, agentSettings);
            }
          } else {
            // No existing process - spawn new
            await spawnNewTerminal(terminal, cwd, addTerminal, agentSettings);
          }
        } catch (error) {
          console.warn(`Failed to restore terminal ${terminal.id}:`, error);
        }
      }
    }

    if (appState.activeWorktreeId) {
      setActiveWorktree(appState.activeWorktreeId);
    }

    await loadRecipes();

    if (appState.developerMode?.enabled && appState.developerMode.autoOpenDiagnostics) {
      const tab = appState.developerMode.focusEventsTab ? "events" : undefined;
      openDiagnosticsDock(tab);
    }

    if (appState.terminalGridConfig) {
      useLayoutConfigStore.getState().setLayoutConfig(appState.terminalGridConfig);
    }
  } catch (error) {
    console.error("Failed to hydrate app state:", error);
    throw error;
  }
}

/**
 * Get the effective agent ID from a terminal state.
 * Handles migration from old type-based system to new agentId-based system.
 */
function getEffectiveAgentId(terminal: TerminalState): string | undefined {
  // New system: use agentId directly
  if (terminal.agentId) {
    return terminal.agentId;
  }
  // Migration: if type is an agent, use type as agentId
  if (terminal.type && isRegisteredAgent(terminal.type)) {
    return terminal.type;
  }
  return undefined;
}

/**
 * Generate the command to run for a terminal on restart.
 *
 * - For agents (claude, gemini, codex): Regenerate command from current settings
 * - For other types with a saved command (scripts, package managers): Use saved command
 * - For plain shells (type=shell with no command): No command
 */
function getRestartCommand(
  terminal: TerminalState,
  agentSettings: AgentSettings | null
): string | undefined {
  const agentId = getEffectiveAgentId(terminal);

  if (agentId) {
    // Regenerate command from current agent settings
    const agentConfig = getAgentConfig(agentId);
    const baseCommand = agentConfig?.command || agentId;

    if (!agentSettings) {
      // Fallback to saved command if settings unavailable
      // This preserves the user's last-known configuration
      return terminal.command?.trim() || baseCommand;
    }

    const flags = generateAgentFlags(agentSettings.agents?.[agentId] ?? {}, agentId);

    return flags.length > 0 ? `${baseCommand} ${flags.join(" ")}` : baseCommand;
  }

  // For non-agent terminals: use saved command if present
  // This covers scripts from QuickRun, package manager commands, etc.
  // Plain shells (type=shell with no command) will return undefined
  return terminal.command?.trim() || undefined;
}

// Helper function for spawning new terminals
async function spawnNewTerminal(
  terminal: TerminalState,
  cwd: string,
  addTerminal: HydrationOptions["addTerminal"],
  agentSettings: AgentSettings | null
): Promise<void> {
  const commandToRun = getRestartCommand(terminal, agentSettings);
  const agentId = getEffectiveAgentId(terminal);
  const kind: TerminalKind = agentId ? "agent" : "terminal";

  await addTerminal({
    kind,
    type: terminal.type,
    agentId,
    title: terminal.title,
    cwd,
    worktreeId: terminal.worktreeId,
    location: terminal.location === "dock" ? "dock" : "grid",
    command: commandToRun,
  });
}
