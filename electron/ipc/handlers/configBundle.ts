import { dialog, BrowserWindow } from "electron";
import { promises as fs } from "node:fs";
import path from "node:path";
import { defineIpcNamespace, op } from "../define.js";
import { CHANNELS } from "../channels.js";
import { CONFIG_BUNDLE_METHOD_CHANNELS } from "./configBundle.preload.js";
import type { HandlerDependencies } from "../types.js";
import { broadcastToRenderer } from "../utils.js";
import { ConfigBundleService } from "../../services/ConfigBundleService.js";
import { buildConfigBundle, parseConfigBundle } from "../../utils/configBundleIO.js";
import {
  CONFIG_BUNDLE_MAX_BYTES,
  type ConfigBundlePreview,
  type ConfigExportResult,
  type ConfigImportReport,
} from "../../../shared/types/configBundle.js";

/**
 * Export / Import Configuration (#11889).
 *
 * The renderer never picks a path or touches the filesystem — it calls these
 * ops and gets back a result, matching every other file-dialog handler in this
 * codebase (`keybinding.ts`, `appTheme.ts`, `projectRecipes.ts`).
 *
 * Import is deliberately split in two: `previewImport` opens the file and
 * reports what *would* change, and `applyImport` writes it. The confirmation
 * step lives between them in the renderer, and `applyImport` re-applies the
 * exact bundle text the user saw rather than re-reading a file that may have
 * changed on disk in the meantime.
 */

const BUNDLE_FILTERS = [{ name: "Daintree Configuration", extensions: ["json"] }];

/**
 * Tell every view to refresh its config mirrors.
 *
 * Each project view is its own V8 context with its own theme and notification
 * stores, and `app.reloadConfig` reconciles neither. Without this, importing
 * from one window leaves every other window showing the previous theme until
 * restart.
 *
 * `broadcastToRenderer` — the same helper `APP_CONFIG_RELOADED` uses — reaches
 * CACHED project views as well as the active one. Walking windows and taking
 * each one's active web contents would miss exactly the backgrounded views that
 * go stale: `notificationSettingsStore.hydrate()` early-returns once hydrated,
 * so a view that never hears this keeps the pre-import values when the user
 * switches back to it.
 */
function broadcastConfigImported(): void {
  broadcastToRenderer(CHANNELS.CONFIG_BUNDLE_IMPORTED);
}

export function registerConfigBundleHandlers(deps: HandlerDependencies): () => void {
  /** Serializes `applyImport` across all windows; see the op for why. */
  let applyChain: Promise<void> = Promise.resolve();

  const rebuildMenu = async () => {
    const win =
      deps.mainWindow && !deps.mainWindow.isDestroyed()
        ? deps.mainWindow
        : BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
    if (!win) return;
    const { createApplicationMenu } = await import("../../menu.js");
    createApplicationMenu(win, deps.cliAvailabilityService);
  };

  // Lazily imported for the same reason `rebuildMenu` is: this handler is
  // registered at boot and neither module belongs on that path.
  const refreshTitleBar = async () => {
    const { refreshTitleBarOverlayTheme } = await import("./appTheme.js");
    refreshTitleBarOverlayTheme();
  };

  const service = new ConfigBundleService({ rebuildMenu, refreshTitleBar });

  const namespace = defineIpcNamespace({
    name: "configBundle",
    ops: {
      export: op(
        CONFIG_BUNDLE_METHOD_CHANNELS.export,
        async (ctx): Promise<ConfigExportResult> => {
          const saveOpts: Electron.SaveDialogOptions = {
            title: "Export configuration",
            defaultPath: "daintree-config.json",
            filters: BUNDLE_FILTERS,
          };

          const parentWindow = ctx.senderWindow;
          const { filePath, canceled } = parentWindow
            ? await dialog.showSaveDialog(parentWindow, saveOpts)
            : await dialog.showSaveDialog(saveOpts);

          if (canceled || !filePath) {
            return { outcome: "canceled", sections: [], omittedSecretPaths: [] };
          }

          // Collected after the destination is chosen, so the file reflects the
          // configuration as of the moment it was written rather than the moment
          // the dialog opened — another window may have changed a setting while
          // the picker sat open.
          const sections = await service.collect();
          const {
            json,
            omittedSecretPaths,
            sections: included,
          } = buildConfigBundle(sections, new Date().toISOString());

          await fs.writeFile(filePath, json, "utf-8");
          return {
            outcome: "written",
            filePath,
            sections: included,
            omittedSecretPaths,
          };
        },
        { withContext: true }
      ),

      previewImport: op(
        CONFIG_BUNDLE_METHOD_CHANNELS.previewImport,
        async (ctx): Promise<ConfigBundlePreview> => {
          const openOpts: Electron.OpenDialogOptions = {
            title: "Import configuration",
            filters: BUNDLE_FILTERS,
            properties: ["openFile"],
          };

          const parentWindow = ctx.senderWindow;
          const { filePaths, canceled } = parentWindow
            ? await dialog.showOpenDialog(parentWindow, openOpts)
            : await dialog.showOpenDialog(openOpts);

          if (canceled || filePaths.length === 0) {
            return { outcome: "canceled", sections: [], unknownSections: [], errors: [] };
          }

          const fileName = path.basename(filePaths[0]);

          // Size-check before reading, not after: `parseConfigBundle` enforces
          // the same cap, but only once the whole file is already resident in
          // the main process.
          const { size } = await fs.stat(filePaths[0]);
          if (size > CONFIG_BUNDLE_MAX_BYTES) {
            return {
              outcome: "rejected",
              fileName,
              sections: [],
              unknownSections: [],
              errors: [`File too large (max ${Math.floor(CONFIG_BUNDLE_MAX_BYTES / 1024)}KB)`],
            };
          }

          const json = await fs.readFile(filePaths[0], "utf-8");
          const parsed = parseConfigBundle(json);
          if (!parsed.ok) {
            return {
              outcome: "rejected",
              fileName,
              exportedAt: parsed.exportedAt,
              schemaVersion: parsed.schemaVersion,
              sections: [],
              unknownSections: parsed.unknownSections,
              errors: parsed.errors,
            };
          }

          return {
            outcome: "ready",
            fileName,
            bundleJson: json,
            exportedAt: parsed.exportedAt,
            schemaVersion: parsed.schemaVersion,
            sections: await service.preview(parsed.sections),
            unknownSections: parsed.unknownSections,
            errors: [],
          };
        },
        { withContext: true }
      ),

      applyImport: op(
        CONFIG_BUNDLE_METHOD_CHANNELS.applyImport,
        async (payload: { bundleJson: string }): Promise<ConfigImportReport> => {
          if (!payload || typeof payload.bundleJson !== "string") {
            throw new Error("Invalid configuration bundle payload");
          }

          // Re-parsed rather than trusted: the renderer round-trip is not a
          // validation boundary, and this is the call that writes.
          const parsed = parseConfigBundle(payload.bundleJson);
          if (!parsed.ok) {
            return {
              outcome: "rolled-back",
              sections: [],
              errors: parsed.errors,
              rolledBack: false,
            };
          }

          // Serialized across every window: two imports interleaving their
          // section writes could roll one back over the other's changes, since
          // each holds its own pre-import snapshot.
          const run = applyChain.then(
            () => service.apply(parsed.sections),
            () => service.apply(parsed.sections)
          );
          applyChain = run.then(
            () => undefined,
            () => undefined
          );
          const report = await run;

          if (report.outcome === "applied") broadcastConfigImported();
          return report;
        }
      ),
    },
  });

  return namespace.register();
}
