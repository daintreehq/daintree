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
import type { PanelLocation, AgentState } from "@/types";
import type {
  TerminalSpawnOptions,
  AgentStateChangePayload,
  AgentDetectedPayload,
  AgentExitedPayload,
  AgentFallbackTriggeredPayload,
  TerminalActivityPayload,
  TerminalStatusPayload,
  SpawnResult,
} from "@shared/types";
import type { TerminalReliabilityMetricPayload } from "@shared/types/pty-host";
import { getAgentConfig } from "@/config/agents";
import { getTerminalAppearanceSnapshot } from "@/hooks/useTerminalAppearance";
import { getScrollbackForType, PERFORMANCE_MODE_SCROLLBACK } from "@/utils/scrollbackConfig";
import { getXtermOptions, calculateTerminalDimensions } from "@/config/xtermConfig";
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
  kind?: "terminal";
  /** Launch hint — agent this terminal will run. Not identity. */
  launchAgentId?: string;
  title?: string;
  worktreeId?: string;
  cwd: string;
  shell?: string;
  command?: string;
  location?: PanelLocation;
  skipCommandExecution?: boolean;
}

/**
 * Result of spawning a terminal.
 */
export interface SpawnTerminalResult {
  id: string;
  kind: "terminal";
  /** Launch hint — agent this terminal was launched to run, if any. */
  launchAgentId?: string;
  title: string;
  agentState?: AgentState;
}

function getDefaultTitle(launchAgentId?: string): string {
  if (launchAgentId) {
    const config = getAgentConfig(launchAgentId);
    if (config) return config.name;
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
    const launchAgentId = options.launchAgentId;
    const kind = "terminal" as const;
    const title = options.title || getDefaultTitle(launchAgentId);

    const commandToExecute = options.skipCommandExecution ? undefined : options.command;

    const spawnOptions: TerminalSpawnOptions = {
      id: options.id,
      cwd: options.cwd,
      shell: options.shell,
      cols: 80,
      rows: 24,
      command: commandToExecute,
      kind,
      launchAgentId,
      title,
    };

    const id = await terminalClient.spawn(spawnOptions);

    return {
      id,
      kind,
      launchAgentId,
      title,
      agentState: launchAgentId ? "idle" : undefined,
    };
  }

  /**
   * Prewarm a terminal's renderer-side xterm instance.
   * Call this after spawning to ensure no output is lost.
   */
  async prewarm(id: string, location: PanelLocation, launchAgentId?: string): Promise<void> {
    const isAgent = Boolean(launchAgentId);
    try {
      const appearance = getTerminalAppearanceSnapshot();
      const { fontSize, fontFamily, performanceMode } = appearance;

      // Project-level scrollback override applies to plain terminals only
      const projectScrollback = isAgent ? undefined : appearance.projectScrollback;
      const effectiveScrollback = performanceMode
        ? PERFORMANCE_MODE_SCROLLBACK
        : getScrollbackForType(isAgent, projectScrollback ?? appearance.scrollbackLines);

      const terminalOptions = getXtermOptions({
        fontSize,
        fontFamily,
        scrollback: effectiveScrollback,
        performanceMode,
        theme: appearance.effectiveTheme,
        screenReaderMode: appearance.screenReaderMode,
      });

      const offscreen = location === "dock";
      const widthPx = location === "dock" ? DOCK_PREWARM_WIDTH_PX : DOCK_TERM_WIDTH;
      const heightPx = location === "dock" ? DOCK_PREWARM_HEIGHT_PX : DOCK_TERM_HEIGHT;

      // Awaited so the instance exists before any sendPtyResize below targets
      // it — prewarmTerminal is async now that the lazy Unicode11 addon is
      // loaded during terminal construction (#10840).
      await terminalInstanceService.prewarmTerminal(id, launchAgentId, terminalOptions, {
        offscreen,
        widthPx,
        heightPx,
      });

      // For offscreen agents, prewarmTerminal's fit() already handles initial
      // PTY resize through settled strategy. Only send explicit resize for
      // active grid spawns where fit() is skipped. Cell metrics come from
      // calculateTerminalDimensions so the lineHeight assumption stays in
      // sync with xtermConfig (1.0 — see BASE_TERMINAL_OPTIONS).
      if (isAgent && !offscreen) {
        const { cols, rows } = calculateTerminalDimensions(widthPx, heightPx, fontSize);
        terminalInstanceService.sendPtyResize(id, cols, rows);
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

  onAgentDetected(handler: (data: AgentDetectedPayload) => void) {
    return terminalClient.onAgentDetected(handler);
  }

  onAgentExited(handler: (data: AgentExitedPayload) => void) {
    return terminalClient.onAgentExited(handler);
  }

  onFallbackTriggered(handler: (data: AgentFallbackTriggeredPayload) => void) {
    return terminalClient.onFallbackTriggered(handler);
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

  onReliabilityMetric(handler: (data: TerminalReliabilityMetricPayload) => void) {
    return terminalClient.onReliabilityMetric(handler);
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

  onBackendRecovering(
    handler: (data: {
      crashType: string;
      code: number | null;
      signal: string | null;
      timestamp: number;
    }) => void
  ) {
    return terminalClient.onBackendRecovering(handler);
  }

  onBackendReady(handler: () => void) {
    return terminalClient.onBackendReady(handler);
  }

  onSpawnResult(handler: (id: string, result: SpawnResult) => void) {
    return terminalClient.onSpawnResult(handler);
  }

  onReduceScrollback(handler: (data: { terminalIds: string[]; targetLines: number }) => void) {
    return terminalClient.onReduceScrollback(handler);
  }

  onRestoreScrollback(handler: (data: { terminalIds: string[] }) => void) {
    return terminalClient.onRestoreScrollback(handler);
  }
}

// Singleton instance
export const terminalRegistryController = new TerminalRegistryController();
