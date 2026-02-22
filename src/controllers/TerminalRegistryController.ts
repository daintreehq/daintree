/**
 * TerminalRegistryController - Encapsulates all IPC and side effects for terminal management.
 *
 * This controller is responsible for:
 * - Spawning new terminals via terminalClient
 * - Killing/trashing/restoring terminals
 * - Prewarming xterm instances
 * - Resizing terminals
 * - Coordinating state changes between backend and store
 *
 * The store (terminalRegistrySlice) should delegate to this controller for any
 * operation that involves IPC or side effects, then update its state accordingly.
 */

import { terminalClient } from "@/clients";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import type { TerminalType, TerminalLocation, AgentState } from "@/types";
import type {
  TerminalSpawnOptions,
  AgentStateChangePayload,
  TerminalActivityPayload,
  TerminalStatusPayload,
  SpawnResult,
} from "@shared/types";
import { isRegisteredAgent, getAgentConfig } from "@/config/agents";
import { getTerminalThemeFromCSS } from "@/utils/terminalTheme";
import { DEFAULT_TERMINAL_FONT_FAMILY } from "@/config/terminalFont";
import { useScrollbackStore } from "@/store/scrollbackStore";
import { usePerformanceModeStore } from "@/store/performanceModeStore";
import { useTerminalFontStore } from "@/store/terminalFontStore";
import { getScrollbackForType, PERFORMANCE_MODE_SCROLLBACK } from "@/utils/scrollbackConfig";
import { TerminalRefreshTier } from "@/types";

// Dock terminal dimensions
const DOCK_WIDTH = 700;
const DOCK_HEIGHT = 500;
const HEADER_HEIGHT = 32;
const PADDING_X = 24;
const PADDING_Y = 24;
const DOCK_TERM_WIDTH = DOCK_WIDTH - PADDING_X;
const DOCK_TERM_HEIGHT = DOCK_HEIGHT - HEADER_HEIGHT - PADDING_Y;
const DOCK_PREWARM_WIDTH_PX = 1200;
const DOCK_PREWARM_HEIGHT_PX = 800;

/**
 * Options for spawning a new terminal.
 */
export interface SpawnTerminalOptions {
  id?: string;
  kind?: "terminal" | "agent";
  type?: TerminalType;
  agentId?: string;
  title?: string;
  worktreeId?: string;
  cwd: string;
  shell?: string;
  command?: string;
  location?: TerminalLocation;
  skipCommandExecution?: boolean;
}

/**
 * Result of spawning a terminal.
 */
export interface SpawnTerminalResult {
  id: string;
  kind: "terminal" | "agent";
  type: TerminalType;
  agentId?: string;
  title: string;
  agentState?: AgentState;
}

function getDefaultTitle(type?: TerminalType, agentId?: string): string {
  if (agentId) {
    const config = getAgentConfig(agentId);
    if (config) {
      return config.name;
    }
  }
  if (type && type !== "terminal") {
    const config = getAgentConfig(type);
    if (config) {
      return config.name;
    }
  }
  return "Terminal";
}

/**
 * Controller for terminal registry operations.
 * Encapsulates all IPC calls and side effects.
 */
class TerminalRegistryController {
  /**
   * Spawn a new terminal via the backend.
   * Returns spawn result with derived values (kind, agentId, title, etc.)
   */
  async spawn(options: SpawnTerminalOptions): Promise<SpawnTerminalResult> {
    const requestedKind = options.kind ?? (options.agentId ? "agent" : "terminal");
    const legacyType: TerminalType = options.type || "terminal";
    const agentId = options.agentId ?? (isRegisteredAgent(legacyType) ? legacyType : undefined);
    const kind: "terminal" | "agent" = agentId ? "agent" : requestedKind;
    const title = options.title || getDefaultTitle(legacyType, agentId);

    const commandToExecute = options.skipCommandExecution ? undefined : options.command;

    const spawnOptions: TerminalSpawnOptions = {
      id: options.id,
      cwd: options.cwd,
      shell: options.shell,
      cols: 80,
      rows: 24,
      command: commandToExecute,
      kind,
      type: legacyType,
      agentId,
      title,
      worktreeId: options.worktreeId,
    };

    const id = await terminalClient.spawn(spawnOptions);

    return {
      id,
      kind,
      type: legacyType,
      agentId,
      title,
      agentState: kind === "agent" ? "idle" : undefined,
    };
  }

  /**
   * Prewarm a terminal's renderer-side xterm instance.
   * Call this after spawning to ensure no output is lost.
   */
  prewarm(
    id: string,
    type: TerminalType,
    kind: "terminal" | "agent",
    location: TerminalLocation
  ): void {
    try {
      const { scrollbackLines } = useScrollbackStore.getState();
      const { performanceMode } = usePerformanceModeStore.getState();
      const { fontSize, fontFamily } = useTerminalFontStore.getState();

      const effectiveScrollback = performanceMode
        ? PERFORMANCE_MODE_SCROLLBACK
        : getScrollbackForType(type, scrollbackLines);

      const terminalOptions = {
        cursorBlink: true,
        cursorStyle: "block" as const,
        cursorInactiveStyle: "block" as const,
        fontSize,
        lineHeight: 1.1,
        letterSpacing: 0,
        fontFamily: fontFamily || DEFAULT_TERMINAL_FONT_FAMILY,
        fontLigatures: false,
        fontWeight: "normal" as const,
        fontWeightBold: "700" as const,
        theme: getTerminalThemeFromCSS(),
        allowProposedApi: true,
        smoothScrollDuration: performanceMode ? 0 : 0,
        scrollback: effectiveScrollback,
        macOptionIsMeta: true,
        scrollOnUserInput: false,
        fastScrollModifier: "alt" as const,
        fastScrollSensitivity: 5,
        scrollSensitivity: 1.5,
      };

      if (kind !== "agent") {
        terminalInstanceService.prewarmTerminal(id, type, terminalOptions, {
          offscreen: location === "dock",
          widthPx: location === "dock" ? DOCK_PREWARM_WIDTH_PX : DOCK_TERM_WIDTH,
          heightPx: location === "dock" ? DOCK_PREWARM_HEIGHT_PX : DOCK_TERM_HEIGHT,
        });
      } else {
        // Agent terminals: set better initial PTY geometry
        const widthPx = location === "dock" ? DOCK_PREWARM_WIDTH_PX : DOCK_TERM_WIDTH;
        const heightPx = location === "dock" ? DOCK_PREWARM_HEIGHT_PX : DOCK_TERM_HEIGHT;
        const cellWidth = Math.max(6, Math.floor(fontSize * 0.6));
        const cellHeight = Math.max(10, Math.floor(fontSize * 1.1));
        const cols = Math.max(20, Math.min(500, Math.floor(widthPx / cellWidth)));
        const rows = Math.max(10, Math.min(200, Math.floor(heightPx / cellHeight)));
        terminalClient.resize(id, cols, rows);
      }
    } catch (error) {
      console.warn(`[TerminalRegistryController] Failed to prewarm terminal ${id}:`, error);
    }
  }

  /**
   * Kill a terminal.
   */
  async kill(id: string): Promise<void> {
    await terminalClient.kill(id);
    terminalInstanceService.destroy(id);
  }

  /**
   * Trash a terminal (soft delete).
   */
  async trash(id: string): Promise<void> {
    await terminalClient.trash(id);
  }

  /**
   * Restore a trashed terminal.
   */
  async restore(id: string): Promise<boolean> {
    return terminalClient.restore(id);
  }

  /**
   * Resize a terminal.
   */
  resize(id: string, cols: number, rows: number): void {
    terminalClient.resize(id, cols, rows);
  }

  /**
   * Set a terminal's activity tier.
   */
  setActivityTier(id: string, tier: "active" | "background"): void {
    terminalClient.setActivityTier(id, tier);
  }

  /**
   * Apply renderer policy for a terminal (affects refresh rate).
   */
  applyRendererPolicy(id: string, tier: TerminalRefreshTier): void {
    terminalInstanceService.applyRendererPolicy(id, tier);
  }

  /**
   * Destroy a terminal's renderer-side instance.
   */
  destroyRendererInstance(id: string): void {
    terminalInstanceService.destroy(id);
  }

  /**
   * Notify that user input occurred (for activity tracking).
   */
  notifyUserInput(id: string): void {
    terminalInstanceService.notifyUserInput(id);
  }

  /**
   * Write data to a terminal.
   */
  write(id: string, data: string): void {
    terminalClient.write(id, data);
  }

  /**
   * Wake a terminal from hibernation.
   */
  async wake(id: string): Promise<{ state: string | null; warnings?: string[] }> {
    return terminalClient.wake(id);
  }

  /**
   * Get terminals for a specific project from the backend.
   */
  async getForProject(projectId: string) {
    return terminalClient.getForProject(projectId);
  }

  /**
   * Reconnect to an existing terminal.
   */
  async reconnect(terminalId: string) {
    return terminalClient.reconnect(terminalId);
  }

  /**
   * Replay terminal history.
   */
  async replayHistory(terminalId: string, maxLines?: number) {
    return terminalClient.replayHistory(terminalId, maxLines);
  }

  /**
   * Force resume a paused terminal.
   */
  async forceResume(id: string) {
    return terminalClient.forceResume(id);
  }

  // --- Subscriptions ---

  onAgentStateChanged(handler: (data: AgentStateChangePayload) => void) {
    return terminalClient.onAgentStateChanged(handler);
  }

  onActivity(handler: (data: TerminalActivityPayload) => void) {
    return terminalClient.onActivity(handler);
  }

  onTrashed(handler: (data: { id: string; expiresAt: number }) => void) {
    return terminalClient.onTrashed(handler);
  }

  onRestored(handler: (data: { id: string }) => void) {
    return terminalClient.onRestored(handler);
  }

  onExit(handler: (id: string, exitCode: number) => void) {
    return terminalClient.onExit(handler);
  }

  onStatus(handler: (data: TerminalStatusPayload) => void) {
    return terminalClient.onStatus(handler);
  }

  onBackendCrashed(
    handler: (data: {
      crashType: string;
      code: number | null;
      signal: string | null;
      timestamp: number;
    }) => void
  ) {
    return terminalClient.onBackendCrashed(handler);
  }

  onBackendReady(handler: () => void) {
    return terminalClient.onBackendReady(handler);
  }

  onSpawnResult(handler: (id: string, result: SpawnResult) => void) {
    return terminalClient.onSpawnResult(handler);
  }
}

// Singleton instance
export const terminalRegistryController = new TerminalRegistryController();
