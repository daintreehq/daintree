import { BrowserWindow, screen } from "electron";
import { store } from "./store.js";

const LEGACY_KEY = "__legacy__";
const MRU_OFFSET_PX = 30;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- generic constraint requires any for assignability
function debounce<T extends (...args: any[]) => void>(func: T, wait: number): T {
  let timeout: NodeJS.Timeout | null = null;
  return ((...args: Parameters<T>) => {
    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(() => func(...args), wait);
  }) as T;
}

type WindowStateBounds = {
  x?: number;
  y?: number;
  width: number;
  height: number;
  isMaximized: boolean;
  isFullScreen: boolean;
};

let lastSavedProjectPath: string | null = null;

function getCurrentProjectPath(): string | null {
  try {
    // Lazy import to avoid circular dependency — projectStore may not be ready at module load
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { projectStore } = require("./services/ProjectStore.js");
    const projectId = projectStore.getCurrentProjectId?.();
    if (!projectId) return null;
    const project = projectStore.getProjectById?.(projectId);
    return project?.path ?? null;
  } catch {
    return null;
  }
}

function getMruBounds(): WindowStateBounds | null {
  const windowStates = store.get("windowStates") ?? {};

  // If we have a last-saved project, use that as MRU
  if (lastSavedProjectPath && windowStates[lastSavedProjectPath]) {
    return { isFullScreen: false, ...windowStates[lastSavedProjectPath] };
  }

  // Otherwise, pick the last entry (any existing state is better than defaults)
  const keys = Object.keys(windowStates);
  if (keys.length > 0) {
    return { isFullScreen: false, ...windowStates[keys[keys.length - 1]] };
  }

  return null;
}

function clampToDisplay(bounds: { x: number; y: number; width: number; height: number }): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  const display = screen.getDisplayMatching(bounds as Electron.Rectangle);
  if (!display) return bounds;
  const wa = display.workArea;
  const clampedWidth = Math.round(Math.min(bounds.width, wa.width));
  const clampedHeight = Math.round(Math.min(bounds.height, wa.height));
  return {
    x: Math.max(wa.x, Math.min(bounds.x, wa.x + wa.width - clampedWidth)),
    y: Math.max(wa.y, Math.min(bounds.y, wa.y + wa.height - clampedHeight)),
    width: clampedWidth,
    height: clampedHeight,
  };
}

function resolveWindowBounds(projectPath: string | null | undefined): WindowStateBounds {
  // 1. Try per-project state
  if (projectPath) {
    const windowStates = store.get("windowStates") ?? {};
    if (windowStates[projectPath]) {
      return { isFullScreen: false, ...windowStates[projectPath] };
    }

    // 2. MRU cascade for new project windows — offset position, suppress maximize/fullscreen
    const mru = getMruBounds();
    if (mru && mru.x !== undefined && mru.y !== undefined) {
      const offset = clampToDisplay({
        x: (mru.x ?? 0) + MRU_OFFSET_PX,
        y: (mru.y ?? 0) + MRU_OFFSET_PX,
        width: mru.width,
        height: mru.height,
      });
      return {
        ...offset,
        isMaximized: false, // Don't cascade into maximized
        isFullScreen: false, // Don't cascade into fullscreen
      };
    }
  }

  // 3. Fall back to legacy windowState (cold-start restores full previous state)
  const legacy = store.get("windowState");
  if (legacy && (legacy.x !== undefined || legacy.width !== 1200)) {
    return { isFullScreen: false, ...legacy };
  }

  // 4. Defaults
  return { width: 1200, height: 800, isMaximized: false, isFullScreen: false };
}

function saveWindowStateForProject(projectPath: string, bounds: WindowStateBounds): void {
  const windowStates = store.get("windowStates") ?? {};
  windowStates[projectPath] = bounds;
  store.set("windowStates", windowStates);
  lastSavedProjectPath = projectPath;
}

export function createWindowWithState(
  options: Electron.BrowserWindowConstructorOptions,
  projectPath?: string | null
): BrowserWindow {
  const windowState = resolveWindowBounds(projectPath);

  const win = new BrowserWindow({
    ...options,
    ...(windowState.x !== undefined && { x: windowState.x }),
    ...(windowState.y !== undefined && { y: windowState.y }),
    width: windowState.width,
    height: windowState.height,
  });

  // Run the off-screen / oversized recovery check against the initial normal-state bounds,
  // before calling maximize() or setFullScreen(). On Windows, getBounds() on a maximized
  // window returns overflow bounds (e.g. width:1928 on a 1920px display) that would falsely
  // trigger the workArea size check. On macOS, native fullscreen bounds exceed workArea.height.
  // Checking here ensures we only ever clamp truly invalid saved states.
  const bounds = win.getBounds();
  const display = screen.getDisplayMatching(bounds);

  if (
    !display ||
    bounds.width <= 0 ||
    bounds.height <= 0 ||
    windowState.x === undefined ||
    windowState.y === undefined
  ) {
    win.center();
  } else {
    const workArea = display.workArea;
    const visibleWidth =
      Math.min(bounds.x + bounds.width, workArea.x + workArea.width) -
      Math.max(bounds.x, workArea.x);
    const visibleHeight =
      Math.min(bounds.y + bounds.height, workArea.y + workArea.height) -
      Math.max(bounds.y, workArea.y);
    const visibleArea = Math.max(0, visibleWidth) * Math.max(0, visibleHeight);
    const totalArea = bounds.width * bounds.height;

    if (
      visibleArea < totalArea * 0.5 ||
      bounds.width > workArea.width ||
      bounds.height > workArea.height
    ) {
      const clampedWidth = Math.round(Math.min(bounds.width, workArea.width));
      const clampedHeight = Math.round(Math.min(bounds.height, workArea.height));
      win.setSize(clampedWidth, clampedHeight);
      win.center();
    }
  }

  // Maximize is applied immediately on the hidden window. Electron updates the
  // internal frame geometry so the OS presents the window already maximized when
  // win.show() is called later — no flash of a normal-sized window.
  //
  // Fullscreen is deferred until after 'show' because macOS native fullscreen
  // requires the window to be visible for the Space transition animation.
  // Fullscreen takes priority over maximize since they are mutually exclusive
  // on macOS (green button = fullscreen, Option+green = maximize).
  if (windowState.isFullScreen) {
    win.once("show", () => {
      if (!win.isDestroyed()) {
        win.setFullScreen(true);
      }
    });
  } else if (windowState.isMaximized) {
    win.maximize();
  }

  const saveState = () => {
    if (win.isDestroyed()) return;

    const isMaximized = win.isMaximized();
    const isFullScreen = win.isFullScreen();

    // getNormalBounds() returns the pre-maximize/pre-fullscreen frame cached by the OS,
    // avoiding the macOS race condition where resize events fire mid-animation and
    // isMaximized() transiently returns false before the transition completes.
    const normalBounds = win.getNormalBounds();

    const entry: WindowStateBounds = {
      x: normalBounds.x,
      y: normalBounds.y,
      width: normalBounds.width,
      height: normalBounds.height,
      isMaximized,
      isFullScreen,
    };

    // Save to per-project state
    const resolvedPath = projectPath ?? getCurrentProjectPath();
    if (resolvedPath) {
      saveWindowStateForProject(resolvedPath, entry);
    } else {
      saveWindowStateForProject(LEGACY_KEY, entry);
    }

    // Also save to legacy key for backward compatibility
    store.set("windowState", entry);
  };

  const debouncedSaveState = debounce(saveState, 500);

  win.on("resize", debouncedSaveState);
  win.on("move", debouncedSaveState);
  win.on("close", saveState);

  return win;
}
