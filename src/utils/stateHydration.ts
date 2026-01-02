import { appClient, terminalClient } from "@/clients";
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
import { isRegisteredAgent } from "@/config/agents";
import { normalizeScrollbackLines } from "@shared/config/scrollback";
import { terminalInstanceService } from "@/services/TerminalInstanceService";

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
  loadRecipes: () => Promise<void>;
  openDiagnosticsDock: (tab?: "problems" | "logs" | "events") => void;
}

export async function hydrateAppState(options: HydrationOptions): Promise<void> {
  const { addTerminal, setActiveWorktree, loadRecipes, openDiagnosticsDock } = options;

  try {
    await keybindingService.loadOverrides();

    // Initialize user agent registry for existing user-defined agents
    // (no UI exposure, but allows existing agents to function)
    await useUserAgentRegistryStore.getState().initialize();

    // Batch fetch initial state
    const { appState, terminalConfig, project: currentProject } = await appClient.hydrate();

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

        for (const terminal of backendTerminals) {
          try {
            console.log(`[Hydration] Reconnecting to terminal: ${terminal.id}`);

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
            console.warn(`Failed to reconnect to terminal ${terminal.id}:`, error);
          }
        }
      } catch (error) {
        console.warn("Failed to query backend terminals:", error);
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
