import { type ManagedTerminal, SCROLLBACK_REDUCE_COOLDOWN_MS } from "./types";
import { useScrollbackStore } from "@/store/scrollbackStore";
import { usePerformanceModeStore } from "@/store/performanceModeStore";
import { useProjectSettingsStore } from "@/store/projectSettingsStore";
import { getScrollbackForType, PERFORMANCE_MODE_SCROLLBACK } from "@/utils/scrollbackConfig";
import { logInfo } from "@/utils/logger";

function getValidScrollbackBase(value: number | undefined): number | undefined {
  if (typeof value !== "number" || Number.isNaN(value) || !Number.isFinite(value)) {
    return undefined;
  }
  return value;
}

function readScrollback(managed: ManagedTerminal): number {
  return managed.terminal.options.scrollback ?? 0;
}

function writeScrollback(managed: ManagedTerminal, lines: number): void {
  managed.terminal.options.scrollback = lines;
}

export interface ReduceScrollbackOptions {
  /**
   * Bypass the per-terminal cooldown. Used by deliberate bulk memory-pressure
   * actions (e.g. resource-profile downshift) that need to shrink every
   * background terminal in lockstep, regardless of recent tab-flip activity.
   */
  force?: boolean;
}

export function reduceScrollback(
  managed: ManagedTerminal,
  targetLines: number,
  options: ReduceScrollbackOptions = {}
): void {
  if (managed.isFocused) return;
  if (managed.isUserScrolledBack) return;
  if (managed.isAltBuffer) return;
  if (managed.terminal.hasSelection()) return;

  if (!options.force) {
    const lastReduceAt = managed.lastScrollbackReduceAt;
    if (lastReduceAt !== undefined && Date.now() - lastReduceAt < SCROLLBACK_REDUCE_COOLDOWN_MS) {
      return;
    }
  }

  const currentScrollback = readScrollback(managed);
  if (currentScrollback <= targetLines) return;

  const scrollbackUsed = managed.terminal.buffer.active.length - managed.terminal.rows;
  writeScrollback(managed, targetLines);
  managed.lastScrollbackReduceAt = Date.now();

  if (scrollbackUsed > targetLines) {
    logInfo("Terminal scrollback reduced under memory pressure", {
      targetLines,
      scrollbackUsed,
      previousScrollback: currentScrollback,
      rows: managed.terminal.rows,
      kind: managed.kind,
      force: options.force === true,
    });
  }
}

export function restoreScrollback(managed: ManagedTerminal): void {
  const { scrollbackLines } = useScrollbackStore.getState();
  const { performanceMode } = usePerformanceModeStore.getState();

  if (performanceMode) {
    writeScrollback(managed, PERFORMANCE_MODE_SCROLLBACK);
    return;
  }

  const isAgent = Boolean(managed.runtimeAgentId);
  const projectScrollback = !isAgent
    ? getValidScrollbackBase(
        useProjectSettingsStore.getState().settings?.terminalSettings?.scrollbackLines
      )
    : undefined;
  const globalScrollback = getValidScrollbackBase(scrollbackLines) ?? 0;

  writeScrollback(managed, getScrollbackForType(isAgent, projectScrollback ?? globalScrollback));
}
