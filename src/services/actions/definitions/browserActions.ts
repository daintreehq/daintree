import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { z } from "zod";
import { systemClient } from "@/clients";
import { usePanelStore } from "@/store/panelStore";
import {
  flushConsoleCaptureBuffer,
  useConsoleCaptureStore,
  type ConsoleLevel,
} from "@/store/consoleCaptureStore";
import { isBrowserPanel, isDevPreviewPanel } from "@shared/types/panel";

function readBrowserUrl(id: string | undefined): string | undefined {
  if (!id) return undefined;
  const panel = usePanelStore.getState().panelsById[id];
  if (!panel) return undefined;
  if (isBrowserPanel(panel) || isDevPreviewPanel(panel)) return panel.browserUrl;
  return undefined;
}

/**
 * Palette gate for `browser.openExternal` / `browser.copyUrl`: both resolve the
 * URL from the focused browser/dev-preview panel and throw when there's none.
 * Used as `requireContext.isReady` so the palette dims the row instead of
 * dispatching `{}` into a throw. Dispatch never evaluates this, so the
 * context-menu/toolbar callers that pass an explicit `terminalId` are
 * unaffected.
 */
function hasFocusedBrowserUrl(): boolean {
  return Boolean(readBrowserUrl(usePanelStore.getState().focusedId ?? undefined));
}

export function registerBrowserActions(actions: ActionRegistry, _callbacks: ActionCallbacks): void {
  actions.set("browser.reload", () => ({
    id: "browser.reload",
    // Browser-toolbar/keybinding affordances that act on the focused browser
    // panel and no-op without one. The two that THROW (openExternal/copyUrl)
    // are requireContext above; these silent navigation ops are hidden — they
    // live on the browser toolbar, not the global palette.
    palette: { mode: "hidden" },
    title: "Reload Browser",
    description: "Reload the browser panel",
    category: "browser",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ terminalId: z.string().optional() }),
    run: async (args: unknown) => {
      const { terminalId } = args as { terminalId?: string };
      const targetId = terminalId ?? usePanelStore.getState().focusedId;
      if (targetId) {
        window.dispatchEvent(
          new CustomEvent("daintree:reload-browser", { detail: { id: targetId } })
        );
      }
    },
  }));

  actions.set("browser.navigate", () => ({
    id: "browser.navigate",
    title: "Navigate Browser",
    description: "Navigate a browser panel to a URL",
    category: "browser",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ url: z.string(), terminalId: z.string().optional() }),
    run: async (args: unknown) => {
      const { url, terminalId } = args as { url: string; terminalId?: string };
      const targetId = terminalId ?? usePanelStore.getState().focusedId;
      // No silent no-op: a no-target dispatch used to return `undefined`, which
      // ActionService wraps as `{ ok: true }` — a false success that left plugin
      // callers unable to detect that nothing navigated. Throw so the failure is
      // explicit. Use `browser.openUrl` to open-or-focus a panel when none exists.
      if (!targetId) {
        throw new Error("No browser panel: pass terminalId or focus a browser panel first");
      }
      window.dispatchEvent(
        new CustomEvent("daintree:browser-navigate", { detail: { id: targetId, url } })
      );
    },
  }));

  actions.set("browser.openUrl", () => ({
    id: "browser.openUrl",
    title: "Open URL in Browser",
    description: "Open a URL in a browser panel, reusing an existing one or creating a new one",
    category: "browser",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["web", "navigate", "panel", "tab"],
    argsSchema: z.object({ url: z.string() }),
    run: async (args: unknown) => {
      const { url } = args as { url: string };
      const store = usePanelStore.getState();
      const existing = store.panelIds
        .map((id) => store.panelsById[id])
        .find((panel) => panel && isBrowserPanel(panel));
      if (existing) {
        store.setBrowserUrl(existing.id, url);
        store.activateTerminal(existing.id);
        return;
      }
      // Omit focusPolicy so the store resolves "auto" vs "preserve" via its MCP
      // focus-suppression guard (#9035) — never steal focus from a typing user.
      const newId = await store.addPanel({ kind: "browser", browserUrl: url });
      // addPanel returns null when the hard panel limit is reached (the store
      // raises its own toast). Throw so callers don't get a false { ok: true }.
      if (!newId) {
        throw new Error("Could not open browser panel: panel limit reached");
      }
    },
  }));

  actions.set("browser.back", () => ({
    id: "browser.back",
    palette: { mode: "hidden" },
    title: "Browser Back",
    description: "Go back in browser history",
    category: "browser",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ terminalId: z.string().optional() }).optional(),
    run: async (args: unknown) => {
      const { terminalId } = (args as { terminalId?: string } | undefined) ?? {};
      const targetId = terminalId ?? usePanelStore.getState().focusedId;
      if (!targetId) return;
      window.dispatchEvent(new CustomEvent("daintree:browser-back", { detail: { id: targetId } }));
    },
  }));

  actions.set("browser.forward", () => ({
    id: "browser.forward",
    palette: { mode: "hidden" },
    title: "Browser Forward",
    description: "Go forward in browser history",
    category: "browser",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ terminalId: z.string().optional() }).optional(),
    run: async (args: unknown) => {
      const { terminalId } = (args as { terminalId?: string } | undefined) ?? {};
      const targetId = terminalId ?? usePanelStore.getState().focusedId;
      if (!targetId) return;
      window.dispatchEvent(
        new CustomEvent("daintree:browser-forward", { detail: { id: targetId } })
      );
    },
  }));

  actions.set("browser.openExternal", () => ({
    id: "browser.openExternal",
    title: "Open in External Browser",
    description: "Open the current URL in external browser",
    category: "browser",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    palette: {
      mode: "requireContext",
      isReady: () => hasFocusedBrowserUrl(),
      reason: "Focus a browser to open its URL externally",
    },
    argsSchema: z
      .object({ terminalId: z.string().optional(), url: z.string().optional() })
      .optional(),
    run: async (args: unknown) => {
      const { terminalId, url } = (args as { terminalId?: string; url?: string } | undefined) ?? {};
      const targetId = terminalId ?? usePanelStore.getState().focusedId ?? undefined;
      const derivedUrl = url ?? readBrowserUrl(targetId);

      if (!derivedUrl) {
        throw new Error("No browser URL available to open externally");
      }

      await systemClient.openExternal(derivedUrl);
    },
  }));

  actions.set("browser.copyUrl", () => ({
    id: "browser.copyUrl",
    title: "Copy URL",
    description: "Copy the current browser URL to clipboard",
    category: "browser",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    palette: {
      mode: "requireContext",
      isReady: () => hasFocusedBrowserUrl(),
      reason: "Focus a browser to copy its URL",
    },
    argsSchema: z
      .object({ terminalId: z.string().optional(), url: z.string().optional() })
      .optional(),
    run: async (args: unknown) => {
      const { terminalId, url } = (args as { terminalId?: string; url?: string } | undefined) ?? {};
      const targetId = terminalId ?? usePanelStore.getState().focusedId ?? undefined;
      const derivedUrl = url ?? readBrowserUrl(targetId);

      if (!derivedUrl) {
        throw new Error("No browser URL available to copy");
      }

      await navigator.clipboard.writeText(derivedUrl);
    },
  }));

  actions.set("browser.setZoomLevel", () => ({
    id: "browser.setZoomLevel",
    palette: { mode: "hidden" },
    title: "Set Browser Zoom Level",
    description: "Set the zoom level for a browser panel",
    category: "browser",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({
      terminalId: z.string().optional(),
      zoomFactor: z.number().min(0.25).max(2.0),
    }),
    run: async (args: unknown) => {
      const { terminalId, zoomFactor } = args as { terminalId?: string; zoomFactor: number };
      const targetId = terminalId ?? usePanelStore.getState().focusedId;
      if (!targetId) return;
      window.dispatchEvent(
        new CustomEvent("daintree:browser-set-zoom", { detail: { id: targetId, zoomFactor } })
      );
    },
  }));

  actions.set("browser.captureScreenshot", () => ({
    id: "browser.captureScreenshot",
    palette: { mode: "hidden" },
    title: "Capture Browser Screenshot",
    description: "Capture a screenshot of the browser viewport and copy to clipboard",
    category: "browser",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ terminalId: z.string().optional() }).optional(),
    run: async (args: unknown) => {
      const { terminalId } = (args as { terminalId?: string } | undefined) ?? {};
      const targetId = terminalId ?? usePanelStore.getState().focusedId;
      if (!targetId) return;
      window.dispatchEvent(
        new CustomEvent("daintree:browser-capture-screenshot", { detail: { id: targetId } })
      );
    },
  }));

  actions.set("browser.toggleConsole", () => ({
    id: "browser.toggleConsole",
    palette: { mode: "hidden" },
    title: "Toggle Browser Console",
    description: "Show or hide the browser console panel",
    category: "browser",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ terminalId: z.string().optional() }).optional(),
    run: async (args: unknown) => {
      const { terminalId } = (args as { terminalId?: string } | undefined) ?? {};
      const targetId = terminalId ?? usePanelStore.getState().focusedId;
      if (!targetId) return;
      window.dispatchEvent(
        new CustomEvent("daintree:browser-toggle-console", { detail: { id: targetId } })
      );
    },
  }));

  actions.set("browser.clearConsole", () => ({
    id: "browser.clearConsole",
    palette: { mode: "hidden" },
    title: "Clear Browser Console",
    description: "Clear all captured console messages for the browser panel",
    category: "browser",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ terminalId: z.string().optional() }).optional(),
    run: async (args: unknown) => {
      const { terminalId } = (args as { terminalId?: string } | undefined) ?? {};
      const targetId = terminalId ?? usePanelStore.getState().focusedId;
      if (!targetId) return;
      window.dispatchEvent(
        new CustomEvent("daintree:browser-clear-console", { detail: { id: targetId } })
      );
    },
  }));

  actions.set("browser.getConsoleMessages", () => ({
    id: "browser.getConsoleMessages",
    palette: { mode: "hidden" },
    title: "Get Browser Console Messages",
    description:
      "Read captured console output (logs, warnings, errors, and stack traces) from a browser or dev-preview panel. Returns the most recent messages plus error/warning counts so an agent can inspect runtime issues without opening the console UI.",
    category: "browser",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    argsSchema: z
      .object({
        terminalId: z.string().optional(),
        level: z.enum(["log", "info", "warning", "error"]).optional(),
        limit: z.number().int().positive().max(500).optional(),
      })
      .optional(),
    resultSchema: z.object({
      paneId: z.string(),
      messages: z.array(
        z.object({
          id: z.number(),
          paneId: z.string(),
          level: z.enum(["log", "info", "warning", "error"]),
          cdpType: z.string(),
          summaryText: z.string(),
          args: z.array(z.unknown()),
          stackTrace: z.unknown().optional(),
          groupDepth: z.number(),
          timestamp: z.number(),
          navigationGeneration: z.number(),
          category: z.string().optional(),
        })
      ),
      counts: z.object({ errorCount: z.number(), warnCount: z.number() }),
    }),
    run: async (args: unknown) => {
      const { terminalId, level, limit } =
        (args as { terminalId?: string; level?: ConsoleLevel; limit?: number } | undefined) ?? {};
      const targetId = terminalId ?? usePanelStore.getState().focusedId;
      if (!targetId) {
        throw new Error(
          "No browser panel: pass terminalId or focus a browser/dev-preview panel first"
        );
      }
      // Commit rows still buffered for the current animation frame so a read
      // immediately after a log isn't missed (mirrors markStale()).
      flushConsoleCaptureBuffer();
      const store = useConsoleCaptureStore.getState();
      let rows = store.getMessages(targetId);
      if (level) {
        rows = rows.filter((row) => row.level === level);
      }
      if (limit !== undefined && rows.length > limit) {
        rows = rows.slice(rows.length - limit);
      }
      // Strip renderer-only UI fields (isStale, timeLabel, isGroupHeader);
      // return only the serialized wire fields an agent can act on.
      const messages = rows.map((row) => ({
        id: row.id,
        paneId: row.paneId,
        level: row.level,
        cdpType: row.cdpType,
        summaryText: row.summaryText,
        args: row.args,
        stackTrace: row.stackTrace,
        groupDepth: row.groupDepth,
        timestamp: row.timestamp,
        navigationGeneration: row.navigationGeneration,
        category: row.category,
      }));
      return { paneId: targetId, messages, counts: store.getCounts(targetId) };
    },
  }));

  actions.set("browser.toggleDevTools", () => ({
    id: "browser.toggleDevTools",
    palette: { mode: "hidden" },
    title: "Toggle Browser DevTools",
    description: "Open or close the browser panel's DevTools",
    category: "browser",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ terminalId: z.string().optional() }).optional(),
    run: async (args: unknown) => {
      const { terminalId } = (args as { terminalId?: string } | undefined) ?? {};
      const targetId = terminalId ?? usePanelStore.getState().focusedId;
      if (!targetId) return;
      window.dispatchEvent(
        new CustomEvent("daintree:browser-toggle-devtools", { detail: { id: targetId } })
      );
    },
  }));

  actions.set("browser.hardReload", () => ({
    id: "browser.hardReload",
    palette: { mode: "hidden" },
    title: "Hard Reload Browser",
    description: "Reload the browser panel bypassing HTTP cache",
    category: "browser",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ terminalId: z.string().optional() }),
    run: async (args: unknown) => {
      const { terminalId } = args as { terminalId?: string };
      const targetId = terminalId ?? usePanelStore.getState().focusedId;
      if (targetId) {
        window.dispatchEvent(
          new CustomEvent("daintree:hard-reload-browser", { detail: { id: targetId } })
        );
      }
    },
  }));
}
