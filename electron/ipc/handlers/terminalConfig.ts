import { dialog, BrowserWindow } from "electron";
import { CHANNELS } from "../channels.js";
import { store } from "../../store.js";
import { parseColorSchemeFile } from "../../utils/colorSchemeImporter.js";
import { effectiveCachedProjectViews } from "../../utils/cachedProjectViews.js";
import type { HandlerDependencies } from "../types.js";
import { typedHandle, typedHandleWithContext } from "../utils.js";
import {
  terminalCustomSchemesReadSchema,
  terminalCustomSchemesWriteSchema,
  migrateCustomSchemes,
} from "../../schemas/customSchemes.js";

function getTerminalConfigObject(): Record<string, unknown> {
  const config = store.get("terminalConfig");
  if (config && typeof config === "object" && !Array.isArray(config)) {
    return config as Record<string, unknown>;
  }
  return {};
}

export function registerTerminalConfigHandlers(deps?: HandlerDependencies): () => void {
  const handlers: Array<() => void> = [];

  handlers.push(
    typedHandle(CHANNELS.TERMINAL_CONFIG_GET, async () => {
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
        customSchemes,
        cachedProjectViews: effectiveCachedProjectViews(config.cachedProjectViews),
      } as import("../../../shared/types/ipc/config.js").TerminalConfig;
    })
  );

  const handleTerminalConfigSetScrollback = async (scrollbackLines: number) => {
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
  };
  handlers.push(
    typedHandle(CHANNELS.TERMINAL_CONFIG_SET_SCROLLBACK, handleTerminalConfigSetScrollback)
  );

  const handleTerminalConfigSetPerformanceMode = async (performanceMode: boolean) => {
    if (typeof performanceMode !== "boolean") {
      console.warn("Invalid terminal performanceMode:", performanceMode);
      return;
    }
    store.set("terminalConfig.performanceMode", performanceMode);
  };
  handlers.push(
    typedHandle(
      CHANNELS.TERMINAL_CONFIG_SET_PERFORMANCE_MODE,
      handleTerminalConfigSetPerformanceMode
    )
  );

  const handleTerminalConfigSetFontSize = async (fontSize: number) => {
    if (!Number.isFinite(fontSize) || !Number.isInteger(fontSize)) {
      console.warn("Invalid terminal fontSize (not a finite integer):", fontSize);
      return;
    }
    if (fontSize < 8 || fontSize > 24) {
      console.warn("Invalid terminal fontSize (out of range 8-24):", fontSize);
      return;
    }
    store.set("terminalConfig.fontSize", fontSize);
  };
  handlers.push(
    typedHandle(CHANNELS.TERMINAL_CONFIG_SET_FONT_SIZE, handleTerminalConfigSetFontSize)
  );

  const handleTerminalConfigSetFontFamily = async (fontFamily: string) => {
    if (typeof fontFamily !== "string" || !fontFamily.trim()) {
      console.warn("Invalid terminal fontFamily:", fontFamily);
      return;
    }
    store.set("terminalConfig.fontFamily", fontFamily.trim());
  };
  handlers.push(
    typedHandle(CHANNELS.TERMINAL_CONFIG_SET_FONT_FAMILY, handleTerminalConfigSetFontFamily)
  );

  const handleTerminalConfigSetHybridInputEnabled = async (enabled: boolean) => {
    if (typeof enabled !== "boolean") {
      console.warn("Invalid terminal hybridInputEnabled:", enabled);
      return;
    }
    store.set("terminalConfig.hybridInputEnabled", enabled);
  };
  handlers.push(
    typedHandle(
      CHANNELS.TERMINAL_CONFIG_SET_HYBRID_INPUT_ENABLED,
      handleTerminalConfigSetHybridInputEnabled
    )
  );

  const handleTerminalConfigSetHybridInputAutoFocus = async (enabled: boolean) => {
    if (typeof enabled !== "boolean") {
      console.warn("Invalid terminal hybridInputAutoFocus:", enabled);
      return;
    }
    store.set("terminalConfig.hybridInputAutoFocus", enabled);
  };
  handlers.push(
    typedHandle(
      CHANNELS.TERMINAL_CONFIG_SET_HYBRID_INPUT_AUTO_FOCUS,
      handleTerminalConfigSetHybridInputAutoFocus
    )
  );

  const handleTerminalConfigSetColorScheme = async (schemeId: string) => {
    if (typeof schemeId !== "string" || !schemeId.trim()) {
      console.warn("Invalid terminal colorScheme:", schemeId);
      return;
    }
    store.set("terminalConfig.colorSchemeId", schemeId.trim());
  };
  handlers.push(
    typedHandle(CHANNELS.TERMINAL_CONFIG_SET_COLOR_SCHEME, handleTerminalConfigSetColorScheme)
  );

  const handleTerminalConfigSetCustomSchemes = async (schemes: unknown) => {
    const result = terminalCustomSchemesWriteSchema.safeParse(schemes);
    if (!result.success) {
      console.warn("Invalid terminal custom schemes:", result.error.message);
      return;
    }
    store.set("terminalConfig.customSchemes", result.data);
  };
  handlers.push(
    typedHandle(CHANNELS.TERMINAL_CONFIG_SET_CUSTOM_SCHEMES, handleTerminalConfigSetCustomSchemes)
  );

  const handleTerminalConfigSetRecentSchemeIds = async (ids: unknown) => {
    if (!Array.isArray(ids)) {
      console.warn("Invalid terminal recentSchemeIds:", ids);
      return;
    }
    const trimmed = ids
      .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
      .map((id) => id.trim());
    const sanitized = Array.from(new Set(trimmed)).slice(0, 5);
    store.set("terminalConfig.recentSchemeIds", sanitized);
  };
  handlers.push(
    typedHandle(
      CHANNELS.TERMINAL_CONFIG_SET_RECENT_SCHEME_IDS,
      handleTerminalConfigSetRecentSchemeIds
    )
  );

  const handleTerminalConfigSetScreenReaderMode = async (mode: string) => {
    if (mode !== "auto" && mode !== "on" && mode !== "off") {
      console.warn("Invalid screen reader mode:", mode);
      return;
    }
    store.set("terminalConfig.screenReaderMode", mode);
  };
  handlers.push(
    typedHandle(
      CHANNELS.TERMINAL_CONFIG_SET_SCREEN_READER_MODE,
      handleTerminalConfigSetScreenReaderMode
    )
  );

  const handleTerminalConfigSetResourceMonitoring = async (enabled: boolean) => {
    if (typeof enabled !== "boolean") {
      console.warn("Invalid terminal resourceMonitoringEnabled:", enabled);
      return;
    }
    store.set("terminalConfig.resourceMonitoringEnabled", enabled);
    deps?.ptyClient?.setResourceMonitoring(enabled);
  };
  handlers.push(
    typedHandle(
      CHANNELS.TERMINAL_CONFIG_SET_RESOURCE_MONITORING,
      handleTerminalConfigSetResourceMonitoring
    )
  );

  const handleTerminalConfigSetMemoryLeakDetection = async (enabled: boolean) => {
    if (typeof enabled !== "boolean") {
      console.warn("Invalid terminal memoryLeakDetectionEnabled:", enabled);
      return;
    }
    store.set("terminalConfig.memoryLeakDetectionEnabled", enabled);
  };
  handlers.push(
    typedHandle(
      CHANNELS.TERMINAL_CONFIG_SET_MEMORY_LEAK_DETECTION,
      handleTerminalConfigSetMemoryLeakDetection
    )
  );

  const handleTerminalConfigSetMemoryLeakAutoRestart = async (thresholdMb: number) => {
    if (!Number.isFinite(thresholdMb) || !Number.isInteger(thresholdMb)) {
      console.warn("Invalid memoryLeakAutoRestartThresholdMb (not a finite integer):", thresholdMb);
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
  };
  handlers.push(
    typedHandle(
      CHANNELS.TERMINAL_CONFIG_SET_MEMORY_LEAK_AUTO_RESTART,
      handleTerminalConfigSetMemoryLeakAutoRestart
    )
  );

  const handleTerminalConfigSetCachedProjectViews = async (cachedProjectViews: number) => {
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
  };
  handlers.push(
    typedHandle(
      CHANNELS.TERMINAL_CONFIG_SET_CACHED_PROJECT_VIEWS,
      handleTerminalConfigSetCachedProjectViews
    )
  );

  handlers.push(
    // @ts-expect-error: handler returns {ok: true|false, ...} — pending migration to throw AppError. See #6020.
    typedHandleWithContext(CHANNELS.TERMINAL_CONFIG_IMPORT_COLOR_SCHEME, async (ctx) => {
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
    })
  );

  return () => handlers.forEach((cleanup) => cleanup());
}
