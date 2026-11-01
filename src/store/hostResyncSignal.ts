import type { HydrateResult } from "@shared/types/ipc/app";
import { logWarn } from "@/utils/logger";
import { PLUGIN_VIEW_RESYNC_EVENT } from "@shared/utils/pluginProjectPresence";

/** The settings an `app:hydrate` answer carries alongside the project's state. */
export interface HydratedSettings {
  terminalConfig: HydrateResult["terminalConfig"] | undefined;
  /** Undefined where the host has never saved any, as its own read reports it. */
  agentSettings: HydrateResult["agentSettings"] | undefined;
  /** Absent from an older host. */
  agentDefaults: HydrateResult["agentDefaults"];
}

export function hydratedSettingsOf(hydrate: HydrateResult): HydratedSettings {
  return {
    terminalConfig: hydrate.terminalConfig,
    agentSettings: hydrate.agentSettings,
    agentDefaults: hydrate.agentDefaults,
  };
}

export interface HostResync {
  /**
   * Set when this pass reads the host's project state through `app:hydrate`,
   * whose answer carries these settings too: it resolves with them, or with
   * null when the pass ends without a usable answer.
   */
  readonly hydrated?: Promise<HydratedSettings | null>;
}

const listeners = new Set<(resync: HostResync) => void>();

/**
 * Called when a remote view's link came back and events from its host may
 * have been lost on the way: state kept from those events should be fetched
 * again. Never fires in a view on this machine.
 */
export function onHostResync(listener: (resync: HostResync) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function notifyHostResync(resync: HostResync = {}): void {
  for (const listener of [...listeners]) {
    try {
      listener(resync);
    } catch (error) {
      logWarn("[HostResync] A listener failed", { error });
    }
  }
  // Plugin views keep state from host pushes too, behind their own SDK copy.
  try {
    globalThis.dispatchEvent?.(new Event(PLUGIN_VIEW_RESYNC_EVENT));
  } catch (error) {
    logWarn("[HostResync] Telling plugin views failed", { error });
  }
}

/**
 * One setting as this resync has it: taken from the pass's hydrate answer when
 * that carries it, so the link isn't asked twice, and read on its own
 * otherwise. Call it when the resync is heard, so any ordering guard the
 * caller holds dates from before the hydrate was asked.
 */
export async function readSettingOnResync<T>(
  resync: HostResync,
  fromHydrate: (settings: HydratedSettings) => T | undefined,
  read: () => Promise<T>
): Promise<T> {
  const hydrated = resync.hydrated ? await resync.hydrated.catch(() => null) : null;
  const value = hydrated ? fromHydrate(hydrated) : undefined;
  return value !== undefined ? value : read();
}
