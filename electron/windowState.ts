import { BrowserWindow, screen } from "electron";
import { windowStatesStore } from "./store.js";

const LEGACY_KEY = "__legacy__";
const MRU_OFFSET_PX = 30;

interface DebouncedFunction<T extends (...args: unknown[]) => void> {
  (...args: Parameters<T>): void;
  cancel: () => void;
  flush: () => void;
}

function debounce<T extends (...args: unknown[]) => void>(
  func: T,
  wait: number
): DebouncedFunction<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const debounced = (...args: Parameters<T>) => {
    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(() => func(...args), wait);
  };
  debounced.cancel = () => {
    if (timeout) {
      clearTimeout(timeout);
      timeout = null;
    }
  };
  debounced.flush = () => {
    if (timeout) {
      clearTimeout(timeout);
      timeout = null;
      func();
    }
  };
  return debounced as DebouncedFunction<T>;
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

// Cached on first use — lazy-require of ProjectStore is a one-shot, not a hot-path reload.
let cachedProjectStore: {
  getCurrentProjectId?: () => string | null;
  getProjectById?: (id: string) => { path?: string } | null;
} | null = undefined as unknown as typeof cachedProjectStore;

function getCurrentProjectPath(): string | null {
  try {
    if (cachedProjectStore === undefined) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { projectStore } = require("./services/ProjectStore.js");
      cachedProjectStore = projectStore ?? null;
    }
    if (!cachedProjectStore) return null;
    const projectId = cachedProjectStore.getCurrentProjectId?.();
    if (!projectId) return null;
    const project = cachedProjectStore.getProjectById?.(projectId);
    return project?.path ?? null;
  } catch (err) {
    if (cachedProjectStore === undefined) {
      console.warn(
        "[WindowState] ProjectStore failed to load, per-project window state disabled:",
        err
      );
      cachedProjectStore = null;
    }
    return null;
  }
}

function getMruBounds(): WindowStateBounds | null {
  const windowStates = windowStatesStore.get("windowStates") ?? {};

  if (lastSavedProjectPath && windowStates[lastSavedProjectPath]) {
    return { isFullScreen: false, ...windowStates[lastSavedProjectPath] };
  }

  if (windowStates[LEGACY_KEY]) {
    return { isFullScreen: false, ...windowStates[LEGACY_KEY] };
  }

  // Last resort: pick any entry (any saved state gives better defaults than none)
  const keys = Object.keys(windowStates);
  if (keys.length > 0) {
    return { isFullScreen: false, ...windowStates[keys[0]] };
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
  const windowStates = windowStatesStore.get("windowStates") ?? {};
  if (projectPath) {
    if (windowStates[projectPath]) {
      return { isFullScreen: false, ...windowStates[projectPath] };
    }

    // 2. MRU cascade for new project windows
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
        isMaximized: false,
        isFullScreen: false,
      };
    }
  }

  // 3. Cold-start restore: startup may not know the project path yet, so use
  // the last shell window state exactly (no cascade offset, preserve maximize).
  if (!projectPath) {
    const mru = getMruBounds();
    if (mru) {
      return mru;
    }
  }

  // 4. Defaults
  return { width: 1200, height: 800, isMaximized: false, isFullScreen: false };
}

function saveWindowStates(projectPath: string | null | undefined, bounds: WindowStateBounds): void {
  const windowStates = windowStatesStore.get("windowStates") ?? {};
  if (projectPath) {
    windowStates[projectPath] = bounds;
  }
  windowStates[LEGACY_KEY] = bounds;
  windowStatesStore.set("windowStates", windowStates);
  lastSavedProjectPath = projectPath ?? LEGACY_KEY;
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

    const normalBounds = win.getNormalBounds();

    const entry: WindowStateBounds = {
      x: normalBounds.x,
      y: normalBounds.y,
      width: normalBounds.width,
      height: normalBounds.height,
      isMaximized,
      isFullScreen,
    };

    const resolvedPath = projectPath ?? getCurrentProjectPath();
    saveWindowStates(resolvedPath, entry);
  };

  const debouncedSaveState = debounce(saveState, 500);

  win.on("resize", debouncedSaveState);
  win.on("move", debouncedSaveState);
  win.on("close", () => {
    debouncedSaveState.cancel();
    saveState();
  });

  return win;
}
