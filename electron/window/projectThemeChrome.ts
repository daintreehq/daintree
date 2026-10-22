import { BrowserWindow } from "electron";
import { setTitleBarOverlayTheme } from "./titleBarOverlay.js";
import { resolveProjectAppScheme } from "./skeletonCss.js";
import { getWindowRegistry } from "./windowRef.js";
import { parseHostScopedKey } from "../../shared/types/remoteHosts.js";

/**
 * The window-level surfaces — the compositor background behind every view and
 * the Windows caption strip — follow the theme of the project the window is
 * showing (#13833), not just the global one.
 */

interface VisibleProjectSource {
  isSwitchBridged(): boolean;
  getOutgoingBridgeProjectId(): string | null;
  getActiveProjectId(): string | null;
}

/**
 * The project on screen in a window. During a cold switch `activeProjectId`
 * already names the incoming project while the outgoing view still covers it,
 * so the chrome stays with the outgoing one until the switch settles.
 */
export function visibleProjectIdOf(source: VisibleProjectSource | null | undefined): string | null {
  if (!source) return null;
  const key = source.isSwitchBridged()
    ? source.getOutgoingBridgeProjectId()
    : source.getActiveProjectId();
  // A remote view is keyed by its host; its renderer knows the bare project id.
  return key ? parseHostScopedKey(key).projectId : null;
}

/** Paint `win`'s chrome in `projectId`'s theme, or the global one with no project. */
export function repaintWindowTheme(win: BrowserWindow, projectId: string | null): void {
  // Decoration on paths (a project switch, a theme write) that must not fail
  // over a colour: Electron rejects an unparseable one from an imported theme.
  try {
    if (win.isDestroyed()) return;
    const scheme = resolveProjectAppScheme(projectId);
    win.setBackgroundColor(scheme.tokens["surface-canvas"]);
    setTitleBarOverlayTheme(win, scheme.tokens);
  } catch (error) {
    console.warn("[projectThemeChrome] Failed to repaint window chrome:", error);
  }
}

/** Repaint every window for the project it is showing — after any theme write. */
export function repaintAllWindowThemes(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    const pvm = getWindowRegistry()?.getByWindowId(win.id)?.services.projectViewManager;
    repaintWindowTheme(win, visibleProjectIdOf(pvm));
  }
}
