import { AppError } from "../utils/errorTypes.js";

/**
 * Service locator for Remote Hosts. Core code (IPC handlers, the dispatcher,
 * broadcast helpers) must never import remote modules statically: they are
 * loaded only behind `if (__DAINTREE_REMOTE_HOSTS__)` so Windows builds drop
 * them. The remote boot registers its services here, and core code reaches
 * them through {@link getRemoteService}.
 *
 * Each remote module declares its entry by augmenting this interface:
 *
 *   declare module "../runtime.js" {
 *     interface RemoteServices { hostRegistry: HostRegistry }
 *   }
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- extended by module augmentation
export interface RemoteServices {}

const services = new Map<keyof RemoteServices, unknown>();

export function registerRemoteService<K extends keyof RemoteServices>(
  key: K,
  service: RemoteServices[K]
): () => void {
  services.set(key, service);
  return () => {
    if (services.get(key) === service) services.delete(key);
  };
}

export function getRemoteService<K extends keyof RemoteServices>(
  key: K
): RemoteServices[K] | undefined {
  return services.get(key) as RemoteServices[K] | undefined;
}

export function requireRemoteService<K extends keyof RemoteServices>(key: K): RemoteServices[K] {
  const service = services.get(key);
  if (service === undefined) {
    throw new AppError({
      code: "UNSUPPORTED",
      message: `Remote hosts service "${String(key)}" is not running`,
      userMessage: "Remote hosts aren't available on this machine.",
    });
  }
  return service as RemoteServices[K];
}

export function _resetRemoteServicesForTest(): void {
  services.clear();
}
