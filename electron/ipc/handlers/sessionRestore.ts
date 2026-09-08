import { store } from "../../store.js";
import { getWindowForWebContents } from "../../window/webContentsRegistry.js";
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

export function registerSessionRestoreHandlers(deps: HandlerDependencies): () => void {
  const namespace = defineIpcNamespace({
    name: "sessionRestore",
    ops: {
      /**
       * The sending view finished hydrating — panels restored and saved agent
       * terminals respawned (#12320).
       *
       * The readiness signal a background restore waits on. It cannot reuse
       * `app:first-interactive`: that one is emitted behind a double
       * `requestAnimationFrame` in `removeStartupSkeleton`, and a
       * background-restored view is never attached to a window, so it is never
       * composited and its animation frames never run.
       *
       * Identity comes from the sender alone — a caller-supplied workspace id
       * would let any view settle another view's restore. Routed to the sending
       * window's own manager, the same per-window resolution `app:view-painted`
       * uses: the process-global manager points at the last-created window, so
       * an older window's view would settle nothing.
       */
      notifyViewHydrated: op(
        SESSION_RESTORE_METHOD_CHANNELS.notifyViewHydrated,
        async (ctx): Promise<void> => {
          const senderWindow = getWindowForWebContents(ctx.event.sender);
          const pvm =
            (senderWindow &&
              deps?.windowRegistry?.getByWindowId(senderWindow.id)?.services?.projectViewManager) ??
            deps?.projectViewManager;
          pvm?.signalViewHydrated(ctx.webContentsId);
        },
        { withContext: true }
      ),
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
