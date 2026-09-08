import { store } from "../../store.js";
import type { SessionRestoreConfig } from "../../../shared/types/ipc/sessionRestore.js";
import type { HandlerDependencies } from "../types.js";
import { defineIpcNamespace, op } from "../define.js";
import { SESSION_RESTORE_METHOD_CHANNELS } from "./sessionRestore.preload.js";

/**
 * Read the stored config, defaulting to enabled.
 *
 * `!== false` rather than `?? true`: a store that predates this key, or one
 * whose value was hand-edited to something that is not a boolean, has not said
 * "off" — and the setting is default-on. Mirrors the read main does before the
 * window fleet is restored, so the Settings toggle and the startup gate can
 * never disagree about what an absent value means.
 */
function readConfig(): SessionRestoreConfig {
  return { enabled: store.get("sessionRestore")?.enabled !== false };
}

export function registerSessionRestoreHandlers(_deps: HandlerDependencies): () => void {
  const namespace = defineIpcNamespace({
    name: "sessionRestore",
    ops: {
      getConfig: op(
        SESSION_RESTORE_METHOD_CHANNELS.getConfig,
        async (): Promise<SessionRestoreConfig> => readConfig()
      ),
      updateConfig: op(
        SESSION_RESTORE_METHOD_CHANNELS.updateConfig,
        async (config: Partial<SessionRestoreConfig>): Promise<SessionRestoreConfig> => {
          if (typeof config !== "object" || config === null || Array.isArray(config)) {
            throw new Error("Invalid config object");
          }
          if (config.enabled !== undefined && typeof config.enabled !== "boolean") {
            throw new Error("enabled must be a boolean");
          }
          if (config.enabled !== undefined) {
            store.set("sessionRestore", { enabled: config.enabled });
          }
          return readConfig();
        }
      ),
    },
  });

  return namespace.register();
}
