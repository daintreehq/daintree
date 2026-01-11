import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { z } from "zod";
import { systemClient } from "@/clients";
import { useTerminalStore } from "@/store/terminalStore";

export function registerBrowserActions(actions: ActionRegistry, _callbacks: ActionCallbacks): void {
  actions.set("browser.reload", () => ({
    id: "browser.reload",
    title: "Reload Browser",
    description: "Reload the browser panel",
    category: "browser",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ terminalId: z.string().optional() }),
    run: async (args: unknown) => {
      const { terminalId } = args as { terminalId?: string };
      const targetId = terminalId ?? useTerminalStore.getState().focusedId;
      if (targetId) {
        window.dispatchEvent(
          new CustomEvent("canopy:reload-browser", { detail: { id: targetId } })
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
      const targetId = terminalId ?? useTerminalStore.getState().focusedId;
      if (!targetId) return;
      window.dispatchEvent(
        new CustomEvent("canopy:browser-navigate", { detail: { id: targetId, url } })
      );
    },
  }));

  actions.set("browser.back", () => ({
    id: "browser.back",
    title: "Browser Back",
    description: "Go back in browser history",
    category: "browser",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ terminalId: z.string().optional() }).optional(),
    run: async (args: unknown) => {
      const { terminalId } = (args as { terminalId?: string } | undefined) ?? {};
      const targetId = terminalId ?? useTerminalStore.getState().focusedId;
      if (!targetId) return;
      window.dispatchEvent(new CustomEvent("canopy:browser-back", { detail: { id: targetId } }));
    },
  }));

  actions.set("browser.forward", () => ({
    id: "browser.forward",
    title: "Browser Forward",
    description: "Go forward in browser history",
    category: "browser",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ terminalId: z.string().optional() }).optional(),
    run: async (args: unknown) => {
      const { terminalId } = (args as { terminalId?: string } | undefined) ?? {};
      const targetId = terminalId ?? useTerminalStore.getState().focusedId;
      if (!targetId) return;
      window.dispatchEvent(new CustomEvent("canopy:browser-forward", { detail: { id: targetId } }));
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
    argsSchema: z
      .object({ terminalId: z.string().optional(), url: z.string().optional() })
      .optional(),
    run: async (args: unknown) => {
      const { terminalId, url } = (args as { terminalId?: string; url?: string } | undefined) ?? {};
      const targetId = terminalId ?? useTerminalStore.getState().focusedId ?? undefined;
      const derivedUrl =
        url ??
        (targetId
          ? useTerminalStore.getState().terminals.find((t) => t.id === targetId)?.browserUrl
          : undefined);

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
    argsSchema: z
      .object({ terminalId: z.string().optional(), url: z.string().optional() })
      .optional(),
    run: async (args: unknown) => {
      const { terminalId, url } = (args as { terminalId?: string; url?: string } | undefined) ?? {};
      const targetId = terminalId ?? useTerminalStore.getState().focusedId ?? undefined;
      const derivedUrl =
        url ??
        (targetId
          ? useTerminalStore.getState().terminals.find((t) => t.id === targetId)?.browserUrl
          : undefined);

      if (!derivedUrl) {
        throw new Error("No browser URL available to copy");
      }

      await navigator.clipboard.writeText(derivedUrl);
    },
  }));

  actions.set("browser.setZoomLevel", () => ({
    id: "browser.setZoomLevel",
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
      const targetId = terminalId ?? useTerminalStore.getState().focusedId;
      if (!targetId) return;
      window.dispatchEvent(
        new CustomEvent("canopy:browser-set-zoom", { detail: { id: targetId, zoomFactor } })
      );
    },
  }));
}
