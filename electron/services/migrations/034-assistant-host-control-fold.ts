import type { Migration } from "../StoreMigrations.js";
import { readStoredHostConnection } from "../../../shared/types/remoteHosts.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Fold each stored host's retired assistant messaging and start switches into
 * its assistant control switch, then drop them (issue #13496): finding,
 * starting and messaging a host's assistants is now control. On an SSH host
 * migration 032 turned both on, so one off now is the person's own choice,
 * and an opt-out of either turns control off too. Elsewhere off was only the
 * default, so a stored control switch stands, and one never stored follows
 * messaging, as it was read before. Anything malformed is left to the
 * registry's reading.
 */
export const migration034: Migration = {
  version: 34,
  description: "Fold assistant messaging and starts into assistant control (issue #13496)",
  up: (store) => {
    const remoteHosts = store.get("remoteHosts") as unknown;
    if (!isPlainObject(remoteHosts) || !Array.isArray(remoteHosts.hosts)) return;

    let changed = false;
    const hosts = remoteHosts.hosts.map((host: unknown) => {
      if (!isPlainObject(host)) return host;
      if (
        !Object.hasOwn(host, "assistantMessagingEnabled") &&
        !Object.hasOwn(host, "assistantStartEnabled")
      ) {
        return host;
      }
      const { assistantMessagingEnabled: messaging, assistantStartEnabled: start, ...rest } = host;
      const control = host.assistantControlEnabled;
      const ssh = readStoredHostConnection(host)?.kind === "ssh";
      let folded: unknown = control;
      if (ssh && (messaging === false || start === false)) folded = false;
      else if (typeof control !== "boolean" && typeof messaging === "boolean") folded = messaging;
      changed = true;
      return folded === undefined ? rest : { ...rest, assistantControlEnabled: folded };
    });
    if (!changed) return;

    store.set("remoteHosts", { ...remoteHosts, hosts } as never);
  },
};
