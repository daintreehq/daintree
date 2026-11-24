import type { HostModeStatus } from "../../../shared/types/ipc/hostMode.js";
import type { HostMode, HostModeSettings } from "./HostModeService.js";

export interface LazyHostModeDeps {
  readSettings(): HostModeSettings;
  /** Where the socket lives (or would), for the status reported before anything loads. */
  socketPath: string | null;
  /** Loads the service's module and hands back its constructor; nothing is built until that runs. */
  load(): Promise<() => HostMode>;
}

/**
 * Host mode's service as the registry holds it (#17027). Its module brings the
 * Host server with it, so a machine that isn't hosting loads it only once
 * something asks Host mode to act: the switch, a handoff, setup, the keychain
 * check, or a status read while the setting says on. Until then a status read
 * answers from the settings alone, as the toolbar asks it from every view.
 */
export function createLazyHostMode(deps: LazyHostModeDeps): HostMode {
  let service: HostMode | null = null;
  let loading: Promise<HostMode | null> | null = null;
  let disposed = false;

  const idleStatus = (): HostModeStatus => {
    const settings = deps.readSettings();
    return {
      supported: true,
      enabled: settings.enabled,
      startAtLogin: settings.startAtLogin,
      advertise: settings.advertise,
      socketPath: deps.socketPath,
      listening: false,
      attachedClients: [],
      // The rows are what the system says, and nothing has asked it yet.
      rows: [],
    };
  };

  /** Built once; null when the quit came first. A load that failed is tried again by the next call. */
  const ensure = (): Promise<HostMode | null> => {
    if (service !== null || disposed) return Promise.resolve(service);
    loading ??= deps.load().then(
      (create) => {
        loading = null;
        if (disposed) return null;
        service = create();
        return service;
      },
      (error: unknown) => {
        loading = null;
        throw error;
      }
    );
    return loading;
  };

  return {
    startListening: () => ensure().then((s) => s?.startListening()),
    stopListening: () =>
      service !== null || loading !== null
        ? ensure().then((s) => s?.stopListening())
        : Promise.resolve(),
    refreshStartAtLogin: () => ensure().then((s) => s?.refreshStartAtLogin()),
    getAttachedClients: () => service?.getAttachedClients() ?? [],
    getStatus: () =>
      service !== null || loading !== null || deps.readSettings().enabled
        ? ensure().then((s) => s?.getStatus() ?? idleStatus())
        : Promise.resolve(idleStatus()),
    setEnabled: (payload) => ensure().then((s) => s?.setEnabled(payload) ?? idleStatus()),
    enableFromSetup: () => ensure().then((s) => s?.enableFromSetup() ?? idleStatus()),
    runKeychainPreflight: () => ensure().then((s) => s?.runKeychainPreflight() ?? idleStatus()),
    async dispose() {
      // A load still in flight sees this and builds nothing.
      disposed = true;
      await service?.dispose();
    },
  };
}
