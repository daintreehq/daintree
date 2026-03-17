import { terminalConfigClient } from "@/clients/terminalConfigClient";
import { useScrollbackStore, usePerformanceModeStore, useTerminalInputStore } from "@/store";
import { normalizeScrollbackLines } from "@shared/config/scrollback";
import { logWarn } from "@/utils/logger";

interface TerminalConfig {
  scrollbackLines?: number;
  performanceMode?: boolean;
  hybridInputEnabled?: boolean;
  hybridInputAutoFocus?: boolean;
}

export function normalizeAndApplyScrollback(
  terminalConfig: TerminalConfig | null | undefined,
  logHydrationInfo: (message: string, context?: Record<string, unknown>) => void
): void {
  try {
    if (terminalConfig?.scrollbackLines !== undefined) {
      const { scrollbackLines } = terminalConfig;
      const normalizedScrollback = normalizeScrollbackLines(scrollbackLines);

      if (normalizedScrollback !== scrollbackLines) {
        logHydrationInfo(
          `Normalizing scrollback from ${scrollbackLines} to ${normalizedScrollback}`
        );
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
}
