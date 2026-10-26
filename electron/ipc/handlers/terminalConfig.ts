// eager-import-allow: writes terminal config via store.set synchronously so the change broadcast reads what landed
import { dialog, BrowserWindow } from "electron";
import { CHANNELS } from "../channels.js";
import { store } from "../../store.js";
import { parseColorSchemeFile } from "../../utils/colorSchemeImporter.js";
import type { HandlerDependencies } from "../types.js";
import { projectViewManagersFrom } from "../../window/activeProjectIds.js";
import { typedHandleWithContext } from "../utils.js";
import { defineIpcNamespace, op } from "../define.js";
import { TERMINAL_CONFIG_METHOD_CHANNELS } from "./terminalConfig.preload.js";
import { terminalCustomSchemesWriteSchema } from "../../schemas/customSchemes.js";
import { notifyTerminalConfigChanged, readTerminalConfig } from "../../services/terminalConfig.js";

export function registerTerminalConfigHandlers(deps?: HandlerDependencies): () => void {
  const namespace = defineIpcNamespace({
    name: "terminalConfig",
    ops: {
      // A read only: a legacy custom-schemes value is parsed in memory, never
      // rewritten, since views call this on boot and on every resync (#14699).
      get: op(TERMINAL_CONFIG_METHOD_CHANNELS.get, async () => readTerminalConfig()),
      setScrollback: op(
        TERMINAL_CONFIG_METHOD_CHANNELS.setScrollback,
        async (scrollbackLines: number) => {
          if (!Number.isFinite(scrollbackLines) || !Number.isInteger(scrollbackLines)) {
            const error = `Invalid scrollback value (not a finite integer): ${scrollbackLines}`;
            console.warn(error);
            throw new Error(error);
          }
          if (scrollbackLines < 100 || scrollbackLines > 10000) {
            const error = `Invalid scrollback value (out of range 100-10000): ${scrollbackLines}`;
            console.warn(error);
            throw new Error(error);
          }
          store.set("terminalConfig.scrollbackLines", scrollbackLines);
          notifyTerminalConfigChanged("scrollbackLines");
        }
      ),
      setPerformanceMode: op(
        TERMINAL_CONFIG_METHOD_CHANNELS.setPerformanceMode,
        async (performanceMode: boolean) => {
          if (typeof performanceMode !== "boolean") {
            console.warn("Invalid terminal performanceMode:", performanceMode);
            return;
          }
          store.set("terminalConfig.performanceMode", performanceMode);
          notifyTerminalConfigChanged("performanceMode");
        }
      ),
      setFontSize: op(TERMINAL_CONFIG_METHOD_CHANNELS.setFontSize, async (fontSize: number) => {
        if (!Number.isFinite(fontSize) || !Number.isInteger(fontSize)) {
          console.warn("Invalid terminal fontSize (not a finite integer):", fontSize);
          return;
        }
        if (fontSize < 8 || fontSize > 24) {
          console.warn("Invalid terminal fontSize (out of range 8-24):", fontSize);
          return;
        }
        store.set("terminalConfig.fontSize", fontSize);
        notifyTerminalConfigChanged("fontSize");
      }),
      setFontFamily: op(
        TERMINAL_CONFIG_METHOD_CHANNELS.setFontFamily,
        async (fontFamily: string) => {
          if (typeof fontFamily !== "string" || !fontFamily.trim()) {
            console.warn("Invalid terminal fontFamily:", fontFamily);
            return;
          }
          store.set("terminalConfig.fontFamily", fontFamily.trim());
          notifyTerminalConfigChanged("fontFamily");
        }
      ),
      setHybridInputEnabled: op(
        TERMINAL_CONFIG_METHOD_CHANNELS.setHybridInputEnabled,
        async (enabled: boolean) => {
          if (typeof enabled !== "boolean") {
            console.warn("Invalid terminal hybridInputEnabled:", enabled);
            return;
          }
          store.set("terminalConfig.hybridInputEnabled", enabled);
          notifyTerminalConfigChanged("hybridInputEnabled");
        }
      ),
      setHybridInputAutoFocus: op(
        TERMINAL_CONFIG_METHOD_CHANNELS.setHybridInputAutoFocus,
        async (enabled: boolean) => {
          if (typeof enabled !== "boolean") {
            console.warn("Invalid terminal hybridInputAutoFocus:", enabled);
            return;
          }
          store.set("terminalConfig.hybridInputAutoFocus", enabled);
          notifyTerminalConfigChanged("hybridInputAutoFocus");
        }
      ),
      setColorScheme: op(
        TERMINAL_CONFIG_METHOD_CHANNELS.setColorScheme,
        async (schemeId: string) => {
          if (typeof schemeId !== "string" || !schemeId.trim()) {
            console.warn("Invalid terminal colorScheme:", schemeId);
            return;
          }
          store.set("terminalConfig.colorSchemeId", schemeId.trim());
          notifyTerminalConfigChanged("colorSchemeId");
        }
      ),
      setCustomSchemes: op(
        TERMINAL_CONFIG_METHOD_CHANNELS.setCustomSchemes,
        async (schemes: unknown) => {
          const result = terminalCustomSchemesWriteSchema.safeParse(schemes);
          if (!result.success) {
            console.warn("Invalid terminal custom schemes:", result.error.message);
            return;
          }
          store.set("terminalConfig.customSchemes", result.data);
          notifyTerminalConfigChanged("customSchemes");
        }
      ),
      setRecentSchemeIds: op(
        TERMINAL_CONFIG_METHOD_CHANNELS.setRecentSchemeIds,
        async (ids: unknown) => {
          if (!Array.isArray(ids)) {
            console.warn("Invalid terminal recentSchemeIds:", ids);
            return;
          }
          const trimmed = ids
            .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
            .map((id) => id.trim());
          const sanitized = Array.from(new Set(trimmed)).slice(0, 5);
          store.set("terminalConfig.recentSchemeIds", sanitized);
          notifyTerminalConfigChanged("recentSchemeIds");
        }
      ),
      setScreenReaderMode: op(
        TERMINAL_CONFIG_METHOD_CHANNELS.setScreenReaderMode,
        async (mode: "auto" | "on" | "off") => {
          if (mode !== "auto" && mode !== "on" && mode !== "off") {
            console.warn("Invalid screen reader mode:", mode);
            return;
          }
          store.set("terminalConfig.screenReaderMode", mode);
          notifyTerminalConfigChanged("screenReaderMode");
        }
      ),
      setResourceMonitoring: op(
        TERMINAL_CONFIG_METHOD_CHANNELS.setResourceMonitoring,
        async (enabled: boolean) => {
          if (typeof enabled !== "boolean") {
            console.warn("Invalid terminal resourceMonitoringEnabled:", enabled);
            return;
          }
          store.set("terminalConfig.resourceMonitoringEnabled", enabled);
          notifyTerminalConfigChanged("resourceMonitoringEnabled");
          deps?.ptyClient?.setResourceMonitoring(enabled);
        }
      ),
      setMemoryLeakDetection: op(
        TERMINAL_CONFIG_METHOD_CHANNELS.setMemoryLeakDetection,
        async (enabled: boolean) => {
          if (typeof enabled !== "boolean") {
            console.warn("Invalid terminal memoryLeakDetectionEnabled:", enabled);
            return;
          }
          store.set("terminalConfig.memoryLeakDetectionEnabled", enabled);
          notifyTerminalConfigChanged("memoryLeakDetectionEnabled");
        }
      ),
      setMemoryLeakAutoRestartThresholdMb: op(
        TERMINAL_CONFIG_METHOD_CHANNELS.setMemoryLeakAutoRestartThresholdMb,
        async (thresholdMb: number) => {
          if (!Number.isFinite(thresholdMb) || !Number.isInteger(thresholdMb)) {
            console.warn(
              "Invalid memoryLeakAutoRestartThresholdMb (not a finite integer):",
              thresholdMb
            );
            return;
          }
          if (thresholdMb < 1024 || thresholdMb > 32768) {
            console.warn(
              "Invalid memoryLeakAutoRestartThresholdMb (out of range 1024-32768):",
              thresholdMb
            );
            return;
          }
          store.set("terminalConfig.memoryLeakAutoRestartThresholdMb", thresholdMb);
          notifyTerminalConfigChanged("memoryLeakAutoRestartThresholdMb");
        }
      ),
      setCachedProjectViews: op(
        TERMINAL_CONFIG_METHOD_CHANNELS.setCachedProjectViews,
        async (cachedProjectViews: number) => {
          if (!Number.isFinite(cachedProjectViews) || !Number.isInteger(cachedProjectViews)) {
            const error = `Invalid cachedProjectViews value (not a finite integer): ${cachedProjectViews}`;
            console.warn(error);
            throw new Error(error);
          }
          if (cachedProjectViews < 1 || cachedProjectViews > 5) {
            const error = `Invalid cachedProjectViews value (out of range 1-5): ${cachedProjectViews}`;
            console.warn(error);
            throw new Error(error);
          }
          store.set("terminalConfig.cachedProjectViews", cachedProjectViews);
          notifyTerminalConfigChanged("cachedProjectViews");
          // Every window holds a copy of the app-wide cap (#14218); the first
          // one set sweeps the whole app, and the rest find it within the cap.
          const managers = new Set(projectViewManagersFrom(deps?.windowRegistry)());
          if (deps?.projectViewManager) managers.add(deps.projectViewManager);
          for (const manager of managers) {
            try {
              manager.setCachedViewLimit(cachedProjectViews);
            } catch (error) {
              console.warn("[terminalConfig] setCachedViewLimit failed for a window:", error);
            }
          }
        }
      ),
    },
  });

  // Register the namespace first so a failure here leaves the standalone
  // legacy handler uninstalled, mirroring the partial-unwind discipline in
  // `define.ts`.
  const namespaceCleanup = namespace.register();

  // `terminal-config:import-color-scheme` returns `{ok: true|false, ...}`,
  // which violates ForbidIpcEnvelopeKeys. Pending migration to throw AppError —
  // see #6020. Until then it stays as a standalone typedHandleWithContext call
  // alongside the namespace.
  let importColorSchemeCleanup: () => void;
  try {
    importColorSchemeCleanup = typedHandleWithContext(
      CHANNELS.TERMINAL_CONFIG_IMPORT_COLOR_SCHEME,
      // @ts-expect-error: handler returns {ok: true|false, ...} — pending migration to throw AppError. See #6020.
      async (ctx) => {
        const win = ctx.senderWindow ?? BrowserWindow.getFocusedWindow();
        const dialogOptions = {
          title: "Import Color Scheme",
          filters: [
            { name: "Color Schemes", extensions: ["itermcolors", "json"] },
            { name: "All Files", extensions: ["*"] },
          ],
          properties: ["openFile" as const],
        };
        const result = win
          ? await dialog.showOpenDialog(win, dialogOptions)
          : await dialog.showOpenDialog(dialogOptions);

        if (result.canceled || result.filePaths.length === 0) {
          return { ok: false as const, errors: ["Import cancelled"] };
        }

        const parsed = await parseColorSchemeFile(result.filePaths[0]);
        if (!parsed.ok) {
          return parsed;
        }
        return {
          ok: true as const,
          scheme: {
            id: parsed.scheme.id,
            name: parsed.scheme.name,
            type: parsed.scheme.type,
            colors: { ...parsed.scheme.colors } as Record<string, string>,
          },
        };
      }
    );
  } catch (error) {
    // Tear the namespace down so a failure here doesn't leave half the
    // channels registered.
    namespaceCleanup();
    throw error;
  }

  return () => {
    importColorSchemeCleanup();
    namespaceCleanup();
  };
}
