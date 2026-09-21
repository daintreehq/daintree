import type { ActionCallbacks, ActionRegistry } from "../actionTypes";

export function registerWindowActions(actions: ActionRegistry, _callbacks: ActionCallbacks): void {
  actions.set("window.toggleFullscreen", () => ({
    id: "window.toggleFullscreen",
    title: "Toggle fullscreen",
    description: "Toggle fullscreen mode for the application window",
    category: "ui",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["maximize", "presentation", "immersive", "expand"],
    run: async () => {
      await window.electron.window.toggleFullscreen();
    },
  }));

  actions.set("window.reload", () => ({
    id: "window.reload",
    title: "Reload window",
    description: "Reload the renderer via Electron webContents",
    category: "ui",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["refresh", "restart", "renderer", "soft"],
    run: async () => {
      await window.electron.window.reload();
    },
  }));

  actions.set("window.forceReload", () => ({
    id: "window.forceReload",
    title: "Force reload window",
    description: "Reload the renderer ignoring cache",
    category: "ui",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["refresh", "cache", "hard", "renderer"],
    run: async () => {
      await window.electron.window.forceReload();
    },
  }));

  actions.set("window.toggleDevTools", () => ({
    id: "window.toggleDevTools",
    title: "Toggle DevTools",
    description: "Toggle Electron DevTools for the current window",
    category: "ui",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["developer", "inspect", "console", "debug"],
    run: async () => {
      await window.electron.window.toggleDevTools();
    },
  }));

  actions.set("window.zoomIn", () => ({
    id: "window.zoomIn",
    title: "Zoom in",
    description: "Increase zoom level",
    category: "ui",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["larger", "increase", "scale", "magnify"],
    run: async () => {
      await window.electron.window.zoomIn();
    },
  }));

  actions.set("window.zoomOut", () => ({
    id: "window.zoomOut",
    title: "Zoom out",
    description: "Decrease zoom level",
    category: "ui",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["smaller", "decrease", "scale", "shrink"],
    run: async () => {
      await window.electron.window.zoomOut();
    },
  }));

  actions.set("window.zoomReset", () => ({
    id: "window.zoomReset",
    title: "Reset zoom",
    description: "Reset zoom level to default",
    category: "ui",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["default", "normal", "scale", "restore"],
    run: async () => {
      await window.electron.window.zoomReset();
    },
  }));

  actions.set("window.close", () => ({
    id: "window.close",
    title: "Close window",
    description: "Close the current window",
    category: "ui",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["dismiss", "shut", "exit", "hide"],
    run: async () => {
      await window.electron.window.close();
    },
  }));
}
