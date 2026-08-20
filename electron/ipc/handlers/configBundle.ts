import { dialog, BrowserWindow } from "electron";
import { promises as fs } from "node:fs";
import path from "node:path";
import { defineIpcNamespace, op } from "../define.js";
import { CONFIG_BUNDLE_METHOD_CHANNELS } from "./configBundle.preload.js";
import type { HandlerDependencies } from "../types.js";
import { ConfigBundleService } from "../../services/ConfigBundleService.js";
import { buildConfigBundle, parseConfigBundle } from "../../utils/configBundleIO.js";
import type {
  ConfigBundlePreview,
  ConfigExportResult,
  ConfigImportReport,
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

export function registerConfigBundleHandlers(deps: HandlerDependencies): () => void {
  const rebuildMenu = async () => {
    const win =
      deps.mainWindow && !deps.mainWindow.isDestroyed()
        ? deps.mainWindow
        : BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
    if (!win) return;
    const { createApplicationMenu } = await import("../../menu.js");
    createApplicationMenu(win, deps.cliAvailabilityService);
  };

  const service = new ConfigBundleService({ rebuildMenu });

  const namespace = defineIpcNamespace({
    name: "configBundle",
    ops: {
      export: op(
        CONFIG_BUNDLE_METHOD_CHANNELS.export,
        async (ctx): Promise<ConfigExportResult> => {
          const sections = await service.collect();
          const {
            json,
            omittedSecretPaths,
            sections: included,
          } = buildConfigBundle(sections, new Date().toISOString());

          const saveOpts: Electron.SaveDialogOptions = {
            title: "Export Configuration",
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
            title: "Import Configuration",
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

          return service.apply(parsed.sections);
        }
      ),
    },
  });

  return namespace.register();
}
