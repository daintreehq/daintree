import { store } from "../../store.js";
import { readWindowOpeningConfig } from "../../window/windowOpeningConfig.js";
import {
  isOpenFoldersInNewWindowMode,
  OPEN_FOLDERS_IN_NEW_WINDOW_MODES,
  type WindowOpeningConfig,
} from "../../../shared/types/ipc/windowOpening.js";
import type { HandlerDependencies } from "../types.js";
import { defineIpcNamespace, op } from "../define.js";
import { WINDOW_OPENING_METHOD_CHANNELS } from "./windowOpening.preload.js";

const CONFIG_KEYS: ReadonlySet<string> = new Set<keyof WindowOpeningConfig>([
  "openFoldersInNewWindow",
]);

export function registerWindowOpeningHandlers(_deps: HandlerDependencies): () => void {
  const namespace = defineIpcNamespace({
    name: "windowOpening",
    ops: {
      getConfig: op(
        WINDOW_OPENING_METHOD_CHANNELS.getConfig,
        async (): Promise<WindowOpeningConfig> => readWindowOpeningConfig()
      ),
      updateConfig: op(
        WINDOW_OPENING_METHOD_CHANNELS.updateConfig,
        async (config: Partial<WindowOpeningConfig>): Promise<WindowOpeningConfig> => {
          if (typeof config !== "object" || config === null || Array.isArray(config)) {
            throw new Error("Invalid config object");
          }
          for (const key of Object.keys(config)) {
            if (!CONFIG_KEYS.has(key)) {
              throw new Error(`Unknown window opening setting: ${key}`);
            }
          }
          const mode = config.openFoldersInNewWindow;
          if (mode !== undefined && !isOpenFoldersInNewWindowMode(mode)) {
            throw new Error(
              `openFoldersInNewWindow must be one of: ${OPEN_FOLDERS_IN_NEW_WINDOW_MODES.join(", ")}`
            );
          }
          if (mode !== undefined) {
            // Spread over the normalised read rather than the raw stored object,
            // so a hand-edited slice is repaired instead of carried forward.
            store.set("windowOpening", {
              ...readWindowOpeningConfig(),
              openFoldersInNewWindow: mode,
            });
          }
          return readWindowOpeningConfig();
        }
      ),
    },
  });

  return namespace.register();
}
