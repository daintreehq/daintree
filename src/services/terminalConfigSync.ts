import type { TerminalConfig, TerminalConfigChange } from "@shared/types";
import { settingOwner, type SettingOwner } from "@shared/config/settingOwnership";
import { normalizeScrollbackLines } from "@shared/config/scrollback";
import type { TerminalColorScheme } from "@/config/terminalColorSchemes";
import { terminalConfigClient } from "@/clients/terminalConfigClient";
import { getSafeBootPromise } from "@/lib/bootPromise";
import { subscribeProjectViewLifecycle } from "@/lib/viewCacheState";
import { onHostResync } from "@/store/hostResyncSignal";
import { useScrollbackStore } from "@/store/scrollbackStore";
import { usePerformanceModeStore } from "@/store/performanceModeStore";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import { useScreenReaderStore } from "@/store/screenReaderStore";
import { useTerminalFontStore } from "@/store/terminalFontStore";
import { useTerminalColorSchemeStore } from "@/store/terminalColorSchemeStore";
import { useCachedProjectViewsStore } from "@/store/cachedProjectViewsStore";
import { useResourceMonitoringStore } from "@/store/resourceMonitoringStore";
import {
  DEFAULT_AUTO_RESTART_THRESHOLD_MB,
  useMemoryLeakConfigStore,
} from "@/store/memoryLeakConfigStore";
import { logWarn } from "@/utils/logger";

type Config = Partial<TerminalConfig>;
type Field = keyof TerminalConfig;

const RECENT_SCHEMES_LIMIT = 5;

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Puts one field of a saved config into this view's store. Each writes only
 * when the value differs: an unchanged value reaching a store can still have
 * effects (autofocus re-seeds the session's focus preference). None of them
 * writes the setting back.
 */
const APPLY: { readonly [K in Field]-?: (config: Config) => void } = {
  scrollbackLines: ({ scrollbackLines }) => {
    if (scrollbackLines === undefined) return;
    const lines = normalizeScrollbackLines(scrollbackLines);
    const store = useScrollbackStore.getState();
    if (store.scrollbackLines !== lines) store.setScrollbackLines(lines);
  },
  performanceMode: ({ performanceMode }) => {
    if (typeof performanceMode !== "boolean") return;
    const store = usePerformanceModeStore.getState();
    if (store.performanceMode !== performanceMode) store.setPerformanceMode(performanceMode);
  },
  hybridInputEnabled: ({ hybridInputEnabled }) => {
    const enabled = hybridInputEnabled ?? true;
    const store = useTerminalInputStore.getState();
    if (store.hybridInputEnabled !== enabled) store.setHybridInputEnabled(enabled);
  },
  hybridInputAutoFocus: ({ hybridInputAutoFocus }) => {
    const enabled = hybridInputAutoFocus ?? true;
    const store = useTerminalInputStore.getState();
    if (store.hybridInputAutoFocus !== enabled) store.setHybridInputAutoFocus(enabled);
  },
  screenReaderMode: ({ screenReaderMode: mode }) => {
    if (mode !== "auto" && mode !== "on" && mode !== "off") return;
    const store = useScreenReaderStore.getState();
    if (store.screenReaderMode !== mode) store.setScreenReaderMode(mode);
  },
  cachedProjectViews: ({ cachedProjectViews }) => {
    const count = cachedProjectViews ?? 1;
    const store = useCachedProjectViewsStore.getState();
    if (store.cachedProjectViews !== count) store.setCachedProjectViews(count);
  },
  fontSize: ({ fontSize }) => {
    if (typeof fontSize !== "number" || !Number.isFinite(fontSize)) return;
    const store = useTerminalFontStore.getState();
    if (store.fontSize !== fontSize) store.setFontSize(fontSize);
  },
  fontFamily: ({ fontFamily }) => {
    if (typeof fontFamily !== "string" || !fontFamily.trim()) return;
    const store = useTerminalFontStore.getState();
    if (store.fontFamily !== fontFamily) store.setFontFamily(fontFamily);
  },
  // Set directly: the store's own setter is a pick, which would put a scheme
  // chosen in another view at the top of this one's recents.
  colorSchemeId: ({ colorSchemeId }) => {
    const id = typeof colorSchemeId === "string" ? colorSchemeId.trim() : "";
    if (!id || useTerminalColorSchemeStore.getState().selectedSchemeId === id) return;
    useTerminalColorSchemeStore.setState({ selectedSchemeId: id });
  },
  // The saved list replaces this view's, so a scheme removed elsewhere goes
  // here too, along with a preview of it.
  customSchemes: ({ customSchemes }) => {
    if (!Array.isArray(customSchemes)) return;
    const schemes = customSchemes as unknown as TerminalColorScheme[];
    const state = useTerminalColorSchemeStore.getState();
    if (sameJson(state.customSchemes, schemes)) return;
    const previewGone =
      state.previewSchemeId !== null &&
      state.customSchemes.some((scheme) => scheme.id === state.previewSchemeId) &&
      !schemes.some((scheme) => scheme.id === state.previewSchemeId);
    useTerminalColorSchemeStore.setState({
      customSchemes: schemes,
      ...(previewGone ? { previewSchemeId: null } : {}),
    });
  },
  recentSchemeIds: ({ recentSchemeIds }) => {
    if (!Array.isArray(recentSchemeIds)) return;
    const ids = recentSchemeIds
      .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
      .map((id) => id.trim())
      .slice(0, RECENT_SCHEMES_LIMIT);
    const store = useTerminalColorSchemeStore.getState();
    if (!sameJson(store.recentSchemeIds, ids)) store.setRecentSchemeIds(ids);
  },
  resourceMonitoringEnabled: ({ resourceMonitoringEnabled }) => {
    const enabled = resourceMonitoringEnabled === true;
    const store = useResourceMonitoringStore.getState();
    if (store.enabled !== enabled) store.setEnabled(enabled);
  },
  // Defaults to on wherever resource monitoring is on.
  memoryLeakDetectionEnabled: ({ memoryLeakDetectionEnabled, resourceMonitoringEnabled }) => {
    const enabled = memoryLeakDetectionEnabled ?? resourceMonitoringEnabled === true;
    const store = useMemoryLeakConfigStore.getState();
    if (store.enabled !== enabled) store.setEnabled(enabled);
  },
  memoryLeakAutoRestartThresholdMb: ({ memoryLeakAutoRestartThresholdMb }) => {
    const threshold = memoryLeakAutoRestartThresholdMb ?? DEFAULT_AUTO_RESTART_THRESHOLD_MB;
    const store = useMemoryLeakConfigStore.getState();
    if (store.autoRestartThresholdMb !== threshold) store.setAutoRestartThresholdMb(threshold);
  },
};

const OWNERS: readonly SettingOwner[] = ["device", "host"];

const FIELDS_OWNED_BY: Readonly<Record<SettingOwner, readonly Field[]>> = (() => {
  const byOwner: Record<SettingOwner, Field[]> = { device: [], host: [] };
  for (const field of Object.keys(APPLY) as Field[]) {
    byOwner[settingOwner(`terminalConfig.${field}`)].push(field);
  }
  return byOwner;
})();

function applyOwnedBy(owner: SettingOwner, config: Config): void {
  for (const field of FIELDS_OWNED_BY[owner]) {
    try {
      APPLY[field](config);
    } catch (error) {
      logWarn("[terminalConfig] Couldn't apply a terminal setting", { field, error });
    }
  }
}

/**
 * Per owner, so a device change doesn't discard the host half of a read in
 * flight. `pushes` counts changes heard; a read that began before the latest
 * one is older than it. `accepted` is the newest read applied, so an earlier
 * read answering late can't put back what a later one replaced.
 */
interface OwnerState {
  pushes: number;
  reads: number;
  accepted: number;
}

const BOOT_TICKET = 0;

function freshState(): Record<SettingOwner, OwnerState> {
  return {
    device: { pushes: 0, reads: BOOT_TICKET, accepted: BOOT_TICKET - 1 },
    host: { pushes: 0, reads: BOOT_TICKET, accepted: BOOT_TICKET - 1 },
  };
}

let owners = freshState();

/** Applies a read's answer, or whichever owner's half of it is still current. */
export type TerminalConfigRead = (config: Config | null | undefined) => void;

function readWith(tickets: Record<SettingOwner, { pushes: number; ticket: number }>) {
  return (config: Config | null | undefined): void => {
    if (!config) return;
    for (const owner of OWNERS) {
      const state = owners[owner];
      const { pushes, ticket } = tickets[owner];
      if (state.pushes !== pushes || ticket <= state.accepted) continue;
      state.accepted = ticket;
      applyOwnedBy(owner, config);
    }
  };
}

/** Call before asking main for the config, and hand the answer to the result. */
export function beginTerminalConfigRead(): TerminalConfigRead {
  const ticket = (owner: SettingOwner) => ({
    pushes: owners[owner].pushes,
    ticket: ++owners[owner].reads,
  });
  return readWith({ device: ticket("device"), host: ticket("host") });
}

/**
 * The boot payload's config. `app:boot` is asked before this view hears any
 * change, so it is older than every push and every other read.
 */
export const applyBootTerminalConfig: TerminalConfigRead = (config) =>
  readWith({
    device: { pushes: 0, ticket: BOOT_TICKET },
    host: { pushes: 0, ticket: BOOT_TICKET },
  })(config);

function receiveChange({ owner, config }: TerminalConfigChange): void {
  if (owner !== "device" && owner !== "host") return;
  owners[owner].pushes += 1;
  applyOwnedBy(owner, config);
}

/**
 * Keeps this view's terminal settings current (#14699): seeded from the boot
 * payload, updated by every saved change on either owner's machine, and read
 * again when the view may have missed one: after its link to a host comes
 * back, and when a cached view returns.
 */
export function initTerminalConfigSync(): () => void {
  const bridge = typeof window === "undefined" ? undefined : window.electron?.terminalConfig;
  if (!bridge || typeof bridge.onChanged !== "function") return () => {};

  let disposed = false;
  const offChange = terminalConfigClient.onChanged((change) => {
    if (!disposed) receiveChange(change);
  });

  const refetch = async (): Promise<void> => {
    const read = beginTerminalConfigRead();
    try {
      const config = await terminalConfigClient.get();
      if (!disposed) read(config);
    } catch (error) {
      // A remote view whose host is unreachable keeps what it had; the
      // resync after the link returns reads it again.
      logWarn("[terminalConfig] Couldn't read terminal settings", { error: String(error) });
    }
  };

  const offResync = onHostResync(() => {
    if (!disposed) void refetch();
  });
  const offLifecycle = subscribeProjectViewLifecycle((phase) => {
    if (phase === "active" && !disposed) void refetch();
  });

  void (async () => {
    const boot = await getSafeBootPromise();
    if (disposed) return;
    const config = boot.ok ? boot.result.terminalConfig : undefined;
    if (config) applyBootTerminalConfig(config);
    else await refetch();
  })();

  return () => {
    disposed = true;
    offChange();
    offResync();
    offLifecycle();
  };
}

export function __resetTerminalConfigSyncForTests(): void {
  owners = freshState();
}
