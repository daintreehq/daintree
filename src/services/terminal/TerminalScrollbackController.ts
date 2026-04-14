import type { ManagedTerminal } from "./types";
import { useScrollbackStore } from "@/store/scrollbackStore";
import { usePerformanceModeStore } from "@/store/performanceModeStore";
import { useProjectSettingsStore } from "@/store/projectSettingsStore";
import { getScrollbackForType, PERFORMANCE_MODE_SCROLLBACK } from "@/utils/scrollbackConfig";

function getValidScrollbackBase(value: number | undefined): number | undefined {
  if (typeof value !== "number" || Number.isNaN(value) || !Number.isFinite(value)) {
    return undefined;
  }
  return value;
}

export function reduceScrollback(managed: ManagedTerminal, targetLines: number): void {
  if (managed.isFocused) return;
  if (managed.isUserScrolledBack) return;
  if (managed.isAltBuffer) return;
  if (managed.terminal.hasSelection()) return;

  const currentScrollback = managed.terminal.options.scrollback ?? 0;
  if (currentScrollback <= targetLines) return;

  const scrollbackUsed = managed.terminal.buffer.active.length - managed.terminal.rows;
  managed.terminal.options.scrollback = targetLines;

  if (scrollbackUsed > targetLines) {
    managed.terminal.write(
      `\r\n\x1b[33m[Canopy] Scrollback reduced to ${targetLines} lines due to memory pressure. Older history is no longer available.\x1b[0m\r\n`
    );
  }
}

export function restoreScrollback(managed: ManagedTerminal): void {
  const { scrollbackLines } = useScrollbackStore.getState();
  const { performanceMode } = usePerformanceModeStore.getState();

  if (performanceMode) {
    managed.terminal.options.scrollback = PERFORMANCE_MODE_SCROLLBACK;
    return;
  }

  const isAgent = managed.kind === "agent";
  const projectScrollback = !isAgent
    ? getValidScrollbackBase(
        useProjectSettingsStore.getState().settings?.terminalSettings?.scrollbackLines
      )
    : undefined;
  const globalScrollback = getValidScrollbackBase(scrollbackLines) ?? 0;

  managed.terminal.options.scrollback = getScrollbackForType(
    managed.type,
    projectScrollback ?? globalScrollback
  );
}
