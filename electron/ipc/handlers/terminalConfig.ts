// eager-import-allow: reads terminal config via store.get synchronously at module scope
import { dialog, BrowserWindow } from "electron";
import { CHANNELS } from "../channels.js";
import { store } from "../../store.js";
import { parseColorSchemeFile } from "../../utils/colorSchemeImporter.js";
import { effectiveCachedProjectViews } from "../../utils/cachedProjectViews.js";
import type { HandlerDependencies } from "../types.js";
import { typedHandleWithContext } from "../utils.js";
import { defineIpcNamespace, op } from "../define.js";
import { TERMINAL_CONFIG_METHOD_CHANNELS } from "./terminalConfig.preload.js";
import {
  terminalCustomSchemesReadSchema,
  terminalCustomSchemesWriteSchema,
  migrateCustomSchemes,
} from "../../schemas/customSchemes.js";
import { normalizeScrollbackLines } from "../../../shared/config/scrollback.js";

function getTerminalConfigObject(): Record<string, unknown> {
  const config = store.get("terminalConfig");
  if (config && typeof config === "object" && !Array.isArray(config)) {
    return config as Record<string, unknown>;
  }
  return {};
}

export function registerTerminalConfigHandlers(deps?: HandlerDependencies): () => void {
  const namespace = defineIpcNamespace({
    name: "terminalConfig",
    ops: {
      get: op(TERMINAL_CONFIG_METHOD_CHANNELS.get, async () => {
        const config = getTerminalConfigObject();
        // Lazy migration: parse legacy customSchemes string into native array
        let customSchemes = config.customSchemes;
        if (typeof customSchemes === "string" || Array.isArray(customSchemes)) {
          const result = migrateCustomSchemes(
            customSchemes,
            terminalCustomSchemesReadSchema,
            terminalCustomSchemesWriteSchema
          );
          if (result.migrated) {
            try {
              store.set(
                "terminalConfig.customSchemes",
                result.schemes.length > 0 ? result.schemes : []
              );
            } catch {
              // Non-fatal: config parsed but migration write failed
            }
          }
          if (result.errors.length > 0) {
            console.warn(
              "[terminalConfig] customSchemes migration warnings:",
              result.errors.join("; ")
            );
          }
          customSchemes = result.schemes;
        } else {
          customSchemes = [];
        }
        return {
          ...config,
          // `TerminalConfig` types these two as required, but nothing on the
          // read path guaranteed them: `getTerminalConfigObject` returns `{}`
          // for a missing or non-object key, electron-store's defaults merge is
          // shallow (a persisted partial `terminalConfig` replaces the default
          // object wholesale), and every writer sets a single dot-path. So the
          // cast below was a lie whenever the persisted object was partial.
          // Backfilling here makes the declared type true for every consumer,
          // including `terminalConfig.get`'s now-enforced `resultSchema`.
          scrollbackLines: normalizeScrollbackLines(config.scrollbackLines),
          performanceMode: config.performanceMode === true,
          customSchemes,
          cachedProjectViews: effectiveCachedProjectViews(config.cachedProjectViews),
        } as import("../../../shared/types/ipc/config.js").TerminalConfig;
      }),
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
      }),
      setFontFamily: op(
        TERMINAL_CONFIG_METHOD_CHANNELS.setFontFamily,
        async (fontFamily: string) => {
          if (typeof fontFamily !== "string" || !fontFamily.trim()) {
            console.warn("Invalid terminal fontFamily:", fontFamily);
            return;
          }
          store.set("terminalConfig.fontFamily", fontFamily.trim());
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
          deps?.projectViewManager?.setCachedViewLimit(cachedProjectViews);
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
