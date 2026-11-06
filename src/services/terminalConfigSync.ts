import type { TerminalConfig, TerminalConfigChange } from "@shared/types";
import { settingOwner, type SettingOwner } from "@shared/config/settingOwnership";
import { normalizeScrollbackLines } from "@shared/config/scrollback";
import type { TerminalColorScheme } from "@/config/terminalColorSchemes";
import { terminalConfigClient } from "@/clients/terminalConfigClient";
import { getSafeBootPromise } from "@/lib/bootPromise";
import { subscribeProjectViewLifecycle } from "@/lib/viewCacheState";
import { onHostResync, readSettingOnResync, type HostResync } from "@/store/hostResyncSignal";
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
 * How one saved field reaches this view's store: the value a saved config
 * means for it (`undefined` when the config says nothing usable), the value
 * the store holds, and how to put a new one there. None writes the setting
 * back.
 */
interface FieldSync<T> {
  resolve(config: Config): T | undefined;
  read(): T;
  write(value: T): void;
}

function field<T>(sync: FieldSync<T>): FieldSync<unknown> {
  return sync;
}

const FIELDS: { readonly [K in Field]-?: FieldSync<unknown> } = {
  scrollbackLines: field({
    resolve: ({ scrollbackLines }) =>
      scrollbackLines === undefined ? undefined : normalizeScrollbackLines(scrollbackLines),
    read: () => useScrollbackStore.getState().scrollbackLines,
    write: (lines) => useScrollbackStore.getState().setScrollbackLines(lines),
  }),
  performanceMode: field({
    resolve: ({ performanceMode }) =>
      typeof performanceMode === "boolean" ? performanceMode : undefined,
    read: () => usePerformanceModeStore.getState().performanceMode,
    write: (enabled) => usePerformanceModeStore.getState().setPerformanceMode(enabled),
  }),
  hybridInputEnabled: field({
    resolve: ({ hybridInputEnabled }) => hybridInputEnabled ?? true,
    read: () => useTerminalInputStore.getState().hybridInputEnabled,
    write: (enabled) => useTerminalInputStore.getState().setHybridInputEnabled(enabled),
  }),
  hybridInputAutoFocus: field({
    resolve: ({ hybridInputAutoFocus }) => hybridInputAutoFocus ?? true,
    read: () => useTerminalInputStore.getState().hybridInputAutoFocus,
    write: (enabled) => useTerminalInputStore.getState().setHybridInputAutoFocus(enabled),
  }),
  screenReaderMode: field({
    resolve: ({ screenReaderMode: mode }) =>
      mode === "auto" || mode === "on" || mode === "off" ? mode : undefined,
    read: () => useScreenReaderStore.getState().screenReaderMode,
    write: (mode) => useScreenReaderStore.getState().setScreenReaderMode(mode),
  }),
  cachedProjectViews: field({
    resolve: ({ cachedProjectViews }) => cachedProjectViews ?? 1,
    read: () => useCachedProjectViewsStore.getState().cachedProjectViews,
    write: (count) => useCachedProjectViewsStore.getState().setCachedProjectViews(count),
  }),
  fontSize: field({
    resolve: ({ fontSize }) =>
      typeof fontSize === "number" && Number.isFinite(fontSize) ? fontSize : undefined,
    read: () => useTerminalFontStore.getState().fontSize,
    write: (size) => useTerminalFontStore.getState().setFontSize(size),
  }),
  fontFamily: field({
    resolve: ({ fontFamily }) =>
      typeof fontFamily === "string" && fontFamily.trim() ? fontFamily : undefined,
    read: () => useTerminalFontStore.getState().fontFamily,
    write: (family) => useTerminalFontStore.getState().setFontFamily(family),
  }),
  // Set directly: the store's own setter is a pick, which would put a scheme
  // chosen in another view at the top of this one's recents.
  colorSchemeId: field({
    resolve: ({ colorSchemeId }) => {
      const id = typeof colorSchemeId === "string" ? colorSchemeId.trim() : "";
      return id || undefined;
    },
    read: () => useTerminalColorSchemeStore.getState().selectedSchemeId,
    write: (id) => useTerminalColorSchemeStore.setState({ selectedSchemeId: id }),
  }),
  // The saved list replaces this view's, so a scheme removed elsewhere goes
  // here too, along with a preview of it.
  customSchemes: field<TerminalColorScheme[]>({
    resolve: ({ customSchemes }) => (Array.isArray(customSchemes) ? customSchemes : undefined),
    read: () => useTerminalColorSchemeStore.getState().customSchemes,
    write: (schemes) => {
      const { customSchemes: before, previewSchemeId } = useTerminalColorSchemeStore.getState();
      const previewGone =
        previewSchemeId !== null &&
        before.some((scheme) => scheme.id === previewSchemeId) &&
        !schemes.some((scheme) => scheme.id === previewSchemeId);
      useTerminalColorSchemeStore.setState({
        customSchemes: schemes,
        ...(previewGone ? { previewSchemeId: null } : {}),
      });
    },
  }),
  recentSchemeIds: field({
    resolve: ({ recentSchemeIds }) =>
      Array.isArray(recentSchemeIds)
        ? recentSchemeIds
            .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
            .map((id) => id.trim())
            .slice(0, RECENT_SCHEMES_LIMIT)
        : undefined,
    read: () => useTerminalColorSchemeStore.getState().recentSchemeIds,
    write: (ids) => useTerminalColorSchemeStore.getState().setRecentSchemeIds(ids),
  }),
  resourceMonitoringEnabled: field({
    resolve: ({ resourceMonitoringEnabled }) => resourceMonitoringEnabled === true,
    read: () => useResourceMonitoringStore.getState().enabled,
    write: (enabled) => useResourceMonitoringStore.getState().setEnabled(enabled),
  }),
  // Defaults to on wherever resource monitoring is on.
  memoryLeakDetectionEnabled: field({
    resolve: ({ memoryLeakDetectionEnabled, resourceMonitoringEnabled }) =>
      memoryLeakDetectionEnabled ?? resourceMonitoringEnabled === true,
    read: () => useMemoryLeakConfigStore.getState().enabled,
    write: (enabled) => useMemoryLeakConfigStore.getState().setEnabled(enabled),
  }),
  memoryLeakAutoRestartThresholdMb: field({
    resolve: ({ memoryLeakAutoRestartThresholdMb }) =>
      memoryLeakAutoRestartThresholdMb ?? DEFAULT_AUTO_RESTART_THRESHOLD_MB,
    read: () => useMemoryLeakConfigStore.getState().autoRestartThresholdMb,
    write: (threshold) => useMemoryLeakConfigStore.getState().setAutoRestartThresholdMb(threshold),
  }),
};

const OWNERS: readonly SettingOwner[] = ["device", "host"];

function isField(name: string): name is Field {
  return Object.hasOwn(FIELDS, name);
}

const FIELDS_OWNED_BY: Readonly<Record<SettingOwner, readonly Field[]>> = (() => {
  const byOwner: Record<SettingOwner, Field[]> = { device: [], host: [] };
  for (const name of Object.keys(FIELDS).filter(isField)) {
    byOwner[settingOwner(`terminalConfig.${name}`)].push(name);
  }
  return byOwner;
})();

/**
 * What this view last heard was saved, per field. A push lands only where it
 * differs from this, so an edit this view hasn't saved yet survives a push
 * about some other field. A read puts every field back to what's saved, which
 * is how a view that drifted (a failed save rolled back to a stale value)
 * comes right again.
 */
let heard = new Map<Field, unknown>();

function applyOwnedBy(owner: SettingOwner, config: Config, from: "read" | "push"): void {
  for (const name of FIELDS_OWNED_BY[owner]) {
    try {
      const sync = FIELDS[name];
      const saved = sync.resolve(config);
      if (saved === undefined) continue;
      if (from === "push" && heard.has(name) && sameJson(heard.get(name), saved)) continue;
      heard.set(name, saved);
      // Left alone when the store has it: some setters do more than store it.
      if (!sameJson(sync.read(), saved)) sync.write(saved);
    } catch (error) {
      logWarn("[terminalConfig] Couldn't apply a terminal setting", { field: name, error });
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

/**
 * The boot payload seeds the first sync only. One started again later (after
 * a dispose) reads instead: changes saved in between were never heard.
 */
let bootSeeded = false;

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
      applyOwnedBy(owner, config, "read");
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
  applyOwnedBy(owner, config, "push");
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
  // Claimed now, so a sync disposed before boot answers still leaves the
  // next one to read.
  const seedFromBoot = !bootSeeded;
  bootSeeded = true;
  const offChange = terminalConfigClient.onChanged((change) => {
    if (!disposed) receiveChange(change);
  });

  const refetch = async (resync: HostResync = {}): Promise<void> => {
    const read = beginTerminalConfigRead();
    try {
      const config = await readSettingOnResync(
        resync,
        (settings) => settings.terminalConfig,
        () => terminalConfigClient.get()
      );
      if (!disposed) read(config);
    } catch (error) {
      // A remote view whose host is unreachable keeps what it had; the
      // resync after the link returns reads it again.
      logWarn("[terminalConfig] Couldn't read terminal settings", { error: String(error) });
    }
  };

  const offResync = onHostResync((resync) => {
    if (!disposed) void refetch(resync);
  });
  const offLifecycle = subscribeProjectViewLifecycle((phase) => {
    if (phase === "active" && !disposed) void refetch();
  });

  void (async () => {
    const boot = await getSafeBootPromise();
    if (disposed) return;
    const config = boot.ok && seedFromBoot ? boot.result.terminalConfig : undefined;
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
  heard = new Map();
  bootSeeded = false;
}
