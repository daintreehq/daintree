import type { BrowserWindow } from "electron";
import type { WindowRegistry } from "./WindowRegistry.js";
import type { ProjectViewManager } from "./ProjectViewManager.js";

let mainWindow: BrowserWindow | null = null;
let registry: WindowRegistry | null = null;
let projectViewManager: ProjectViewManager | null = null;

export function setWindowRegistry(reg: WindowRegistry): void {
  registry = reg;
}

export function getWindowRegistry(): WindowRegistry | null {
  return registry;
}

export function setMainWindow(win: BrowserWindow | null): void {
  mainWindow = win;
}

export function getMainWindow(): BrowserWindow | null {
  if (registry) {
    const primary = registry.getPrimary();
    if (primary) return primary.browserWindow;
  }
  return mainWindow;
}

export function setProjectViewManager(pvm: ProjectViewManager | null): void {
  projectViewManager = pvm;
}

export function getProjectViewManager(): ProjectViewManager | null {
  return projectViewManager;
}
