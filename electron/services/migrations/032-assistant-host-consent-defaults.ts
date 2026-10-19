import type { Migration } from "../StoreMigrations.js";
import { readStoredHostConnection } from "../../../shared/types/remoteHosts.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Turn assistant messaging and starting assistants on for every stored SSH
 * host (issue #13469). Hosts were saved with start consent written off, and
 * with messaging off when added before its SSH default or reset by a change of
 * target, so a stored false says nothing about what the person chose. Runs
 * once; an off the person sets afterwards stays off.
 */
export const migration032: Migration = {
  version: 32,
  description: "Default assistant messaging and starts on for SSH hosts (issue #13469)",
  up: (store) => {
    const remoteHosts = store.get("remoteHosts") as unknown;
    if (!isPlainObject(remoteHosts) || !Array.isArray(remoteHosts.hosts)) return;

    let changed = false;
    const hosts = remoteHosts.hosts.map((host: unknown) => {
      if (!isPlainObject(host) || readStoredHostConnection(host)?.kind !== "ssh") return host;
      if (host.assistantMessagingEnabled === true && host.assistantStartEnabled === true) {
        return host;
      }
      changed = true;
      return { ...host, assistantMessagingEnabled: true, assistantStartEnabled: true };
    });
    if (!changed) return;

    store.set("remoteHosts", { ...remoteHosts, hosts } as never);
  },
};
