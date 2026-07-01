import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { z } from "zod";
import { terminalConfigClient } from "@/clients";
import { usePerformanceModeStore } from "@/store/performanceModeStore";
import { useScreenReaderStore } from "@/store/screenReaderStore";
import { useCachedProjectViewsStore } from "@/store/cachedProjectViewsStore";
import { useScrollbackStore } from "@/store/scrollbackStore";
import { useTerminalFontStore } from "@/store/terminalFontStore";
import { useTerminalInputStore } from "@/store/terminalInputStore";

export function registerTerminalConfigActions(
  actions: ActionRegistry,
  _callbacks: ActionCallbacks
): void {
  actions.set("terminalConfig.get", () => ({
    id: "terminalConfig.get",
    title: "Get Terminal Config",
    description: "Get persisted terminal configuration",
    category: "settings",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    resultSchema: z.object({
      scrollbackLines: z.number(),
      performanceMode: z.boolean(),
      fontSize: z.number().optional(),
      fontFamily: z.string().optional(),
      hybridInputEnabled: z.boolean().optional(),
      hybridInputAutoFocus: z.boolean().optional(),
      colorSchemeId: z.string().optional(),
      screenReaderMode: z.enum(["auto", "on", "off"]).optional(),
      resourceMonitoringEnabled: z.boolean().optional(),
      memoryLeakDetectionEnabled: z.boolean().optional(),
      memoryLeakAutoRestartThresholdMb: z.number().optional(),
      cachedProjectViews: z.number().optional(),
    }),
    run: async () => {
      return await terminalConfigClient.get();
    },
  }));

  actions.set("terminalConfig.setScrollback", () => ({
    id: "terminalConfig.setScrollback",
    title: "Set Scrollback",
    description: "Set terminal scrollback lines",
    category: "settings",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ scrollbackLines: z.number().int().min(100).max(10000) }),
    run: async (args: unknown) => {
      const { scrollbackLines } = args as { scrollbackLines: number };
      const state = useScrollbackStore.getState();
      const previous = state.scrollbackLines;
      state.setScrollbackLines(scrollbackLines);

      try {
        await terminalConfigClient.setScrollback(scrollbackLines);
      } catch (error) {
        state.setScrollbackLines(previous);
        throw error;
      }
    },
  }));

  actions.set("terminalConfig.setPerformanceMode", () => ({
    id: "terminalConfig.setPerformanceMode",
    title: "Set Performance Mode",
    description: "Enable or disable performance mode",
    category: "settings",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ performanceMode: z.boolean() }),
    run: async (args: unknown) => {
      const { performanceMode } = args as { performanceMode: boolean };
      const state = usePerformanceModeStore.getState();
      const previous = state.performanceMode;
      state.setPerformanceMode(performanceMode);

      try {
        await terminalConfigClient.setPerformanceMode(performanceMode);
      } catch (error) {
        state.setPerformanceMode(previous);
        throw error;
      }
    },
  }));

  actions.set("terminalConfig.setFontSize", () => ({
    id: "terminalConfig.setFontSize",
    title: "Set Terminal Font Size",
    description: "Set terminal font size",
    category: "settings",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ fontSize: z.number().int().min(8).max(48) }),
    run: async (args: unknown) => {
      const { fontSize } = args as { fontSize: number };
      const state = useTerminalFontStore.getState();
      const previous = state.fontSize;
      state.setFontSize(fontSize);

      try {
        await terminalConfigClient.setFontSize(fontSize);
      } catch (error) {
        state.setFontSize(previous);
        throw error;
      }
    },
  }));

  actions.set("terminalConfig.setFontFamily", () => ({
    id: "terminalConfig.setFontFamily",
    title: "Set Terminal Font Family",
    description: "Set terminal font family",
    category: "settings",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ fontFamily: z.string().min(1) }),
    run: async (args: unknown) => {
      const { fontFamily } = args as { fontFamily: string };
      const state = useTerminalFontStore.getState();
      const previous = state.fontFamily;
      state.setFontFamily(fontFamily);

      try {
        await terminalConfigClient.setFontFamily(fontFamily);
      } catch (error) {
        state.setFontFamily(previous);
        throw error;
      }
    },
  }));

  actions.set("terminalConfig.setHybridInputEnabled", () => ({
    id: "terminalConfig.setHybridInputEnabled",
    title: "Set Hybrid Input Enabled",
    description: "Enable or disable the hybrid input bar",
    category: "settings",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ enabled: z.boolean() }),
    run: async (args: unknown) => {
      const { enabled } = args as { enabled: boolean };
      const state = useTerminalInputStore.getState();
      const previous = state.hybridInputEnabled;
      state.setHybridInputEnabled(enabled);

      try {
        await terminalConfigClient.setHybridInputEnabled(enabled);
      } catch (error) {
        state.setHybridInputEnabled(previous);
        throw error;
      }
    },
  }));

  actions.set("terminalConfig.setHybridInputAutoFocus", () => ({
    id: "terminalConfig.setHybridInputAutoFocus",
    title: "Set Default Focus Target",
    description:
      "Choose whether agent panes start with the hybrid input or the terminal focused — runtime clicks still win",
    category: "settings",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ enabled: z.boolean() }),
    run: async (args: unknown) => {
      const { enabled } = args as { enabled: boolean };
      const state = useTerminalInputStore.getState();
      const previous = state.hybridInputAutoFocus;
      state.setHybridInputAutoFocus(enabled);

      try {
        await terminalConfigClient.setHybridInputAutoFocus(enabled);
      } catch (error) {
        state.setHybridInputAutoFocus(previous);
        throw error;
      }
    },
  }));

  actions.set("terminalConfig.setScreenReaderMode", () => ({
    id: "terminalConfig.setScreenReaderMode",
    title: "Set Screen Reader Mode",
    description: "Set screen reader mode for terminals (auto, on, or off)",
    category: "settings",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ mode: z.enum(["auto", "on", "off"]) }),
    run: async (args: unknown) => {
      const { mode } = args as { mode: "auto" | "on" | "off" };
      const state = useScreenReaderStore.getState();
      const previous = state.screenReaderMode;
      state.setScreenReaderMode(mode);

      try {
        await terminalConfigClient.setScreenReaderMode(mode);
      } catch (error) {
        state.setScreenReaderMode(previous);
        throw error;
      }
    },
  }));

  actions.set("terminalConfig.setCachedProjectViews", () => ({
    id: "terminalConfig.setCachedProjectViews",
    title: "Set Cached Project Views",
    description: "Set the number of project views to keep cached in memory (1–5)",
    category: "settings",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ cachedProjectViews: z.number().int().min(1).max(5) }),
    run: async (args: unknown) => {
      const { cachedProjectViews } = args as { cachedProjectViews: number };
      const state = useCachedProjectViewsStore.getState();
      const previous = state.cachedProjectViews;
      state.setCachedProjectViews(cachedProjectViews);

      try {
        await terminalConfigClient.setCachedProjectViews(cachedProjectViews);
      } catch (error) {
        state.setCachedProjectViews(previous);
        throw error;
      }
    },
  }));
}
