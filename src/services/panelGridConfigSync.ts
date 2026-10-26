import type { PanelGridConfig } from "@shared/types";
import { appClient } from "@/clients/appClient";
import { useLayoutConfigStore } from "@/store/layoutConfigStore";

const STRATEGIES = new Set<PanelGridConfig["strategy"]>([
  "automatic",
  "fixed-columns",
  "fixed-rows",
]);

function isPanelGridConfig(value: unknown): value is PanelGridConfig {
  if (!value || typeof value !== "object") return false;
  const { strategy, value: count } = value as Partial<PanelGridConfig>;
  return (
    typeof strategy === "string" &&
    STRATEGIES.has(strategy) &&
    typeof count === "number" &&
    Number.isFinite(count)
  );
}

function apply(config: PanelGridConfig): void {
  const { layoutConfig, setLayoutConfig } = useLayoutConfigStore.getState();
  if (layoutConfig.strategy === config.strategy && layoutConfig.value === config.value) return;
  setLayoutConfig({ strategy: config.strategy, value: config.value });
}

/** Changes heard; a read that began before the latest one is older than it. */
let pushes = 0;

/** Applies a read's answer unless a saved change was heard while it travelled. */
export type PanelGridConfigRead = (config: unknown) => void;

function readAt(seen: number): PanelGridConfigRead {
  return (config) => {
    if (pushes !== seen || !isPanelGridConfig(config)) return;
    apply(config);
  };
}

/** Call before asking main for the grid, and hand the answer to the result. */
export function beginPanelGridConfigRead(): PanelGridConfigRead {
  return readAt(pushes);
}

/** The boot payload is older than every push this view hears. */
export const applyBootPanelGridConfig: PanelGridConfigRead = (config) => readAt(0)(config);

/**
 * Keeps this view's grid layout on what this machine saved (#14700). The grid
 * is device-owned, so every view on this machine hears the change, a view of
 * another host included, and a cached view hears it while hidden.
 */
export function initPanelGridConfigSync(): () => void {
  const bridge = typeof window === "undefined" ? undefined : window.electron?.app;
  if (!bridge || typeof bridge.onPanelGridConfigChanged !== "function") return () => {};

  let disposed = false;
  const off = appClient.onPanelGridConfigChanged((config) => {
    if (disposed) return;
    pushes += 1;
    if (isPanelGridConfig(config)) apply(config);
  });
  return () => {
    disposed = true;
    off();
  };
}

export function __resetPanelGridConfigSyncForTests(): void {
  pushes = 0;
}
