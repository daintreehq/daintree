import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { isMac, isWindows } from "@/lib/platform";

// Padding that pushes a top-of-window surface's content clear of the OS window
// controls — macOS traffic lights (top-left) and Windows caption buttons
// (top-right). Empty outside a provider, so the bare component (used inline
// inside terminals, dialogs, etc. where no OS chrome overlaps) is unaffected.
const EMPTY: CSSProperties = Object.freeze({});
const WindowControlsInsetContext = createContext<CSSProperties>(EMPTY);

export function useWindowControlsInset(): CSSProperties {
  return useContext(WindowControlsInsetContext);
}

/**
 * Reserves space for the OS window controls for any surface pinned to the very
 * top of the window (the global banner host). Mirrors the Toolbar /
 * PluginManager spacers: macOS reserves ~80px on the left (matching the
 * toolbar's `px-4` + `w-16` lead-in), Windows reserves the caption-button strip
 * on the right via `titlebar-area-width`, Linux reserves nothing. All collapse
 * in fullscreen, where the OS chrome is gone.
 */
export function WindowControlsInsetProvider({ children }: { children: ReactNode }) {
  const [isFullscreen, setIsFullscreen] = useState(false);
  useEffect(() => window.electron?.window?.onFullscreenChange?.(setIsFullscreen), []);

  const inset = useMemo<CSSProperties>(() => {
    if (isFullscreen) return EMPTY;
    if (isMac()) return { paddingLeft: "5rem" };
    if (isWindows())
      return { paddingRight: "calc(100vw - env(titlebar-area-width, calc(100vw - 138px)))" };
    return EMPTY;
  }, [isFullscreen]);

  return (
    <WindowControlsInsetContext.Provider value={inset}>
      {children}
    </WindowControlsInsetContext.Provider>
  );
}
