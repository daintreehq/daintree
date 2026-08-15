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
import { WINDOWS_CAPTION_WIDTH_PX, type BannerSeverity } from "@shared/config/windowChrome";

// Padding that pushes a top-of-window surface's content clear of the OS window
// controls — macOS traffic lights (top-left) and Windows caption buttons
// (top-right). Empty outside a provider, so the bare component (used inline
// inside terminals, dialogs, etc. where no OS chrome overlaps) is unaffected.
const EMPTY: CSSProperties = Object.freeze({});
const WindowControlsInsetContext = createContext<CSSProperties>(EMPTY);

/**
 * Set only by the global banner host. A surface that has this is sharing the
 * window's title-bar band with the OS caption buttons, which makes it
 * responsible for the drag region the toolbar normally provides — and lets it
 * report itself so the native caption strip can be tinted to match.
 *
 * `null` for every ordinary in-page usage, which is what keeps banners inside
 * terminals and dialogs from turning into window drag handles.
 */
const TitleBarSurfaceContext = createContext<((severity: BannerSeverity | null) => void) | null>(
  null
);

export function useWindowControlsInset(): CSSProperties {
  return useContext(WindowControlsInsetContext);
}

/**
 * Reporter for a surface occupying the window's title-bar band, or `null` when
 * rendered anywhere else. Presence doubles as the "am I the global banner?" flag.
 */
export function useTitleBarSurface(): ((severity: BannerSeverity | null) => void) | null {
  return useContext(TitleBarSurfaceContext);
}

/**
 * Reserves space for the OS window controls for any surface pinned to the very
 * top of the window (the global banner host). Mirrors the Toolbar /
 * PluginManager spacers: macOS reserves ~80px on the left (matching the
 * toolbar's `px-4` + `w-16` lead-in), Windows reserves the caption-button strip
 * on the right, Linux reserves nothing. All collapse in fullscreen, where the
 * OS chrome is gone.
 *
 * The Windows width is a constant rather than `env(titlebar-area-width)`: those
 * variables are scoped to the BrowserWindow's own webContents and never resolve
 * in the child WebContentsView this app renders in — see
 * `shared/config/windowChrome.ts`.
 */
export function WindowControlsInsetProvider({
  children,
  onSeverityChange,
}: {
  children: ReactNode;
  /** Present only for the global banner host — see {@link useTitleBarSurface}. */
  onSeverityChange?: (severity: BannerSeverity | null) => void;
}) {
  const [isFullscreen, setIsFullscreen] = useState(false);
  useEffect(() => window.electron?.window?.onFullscreenChange?.(setIsFullscreen), []);

  const inset = useMemo<CSSProperties>(() => {
    if (isFullscreen) return EMPTY;
    if (isMac()) return { paddingLeft: "5rem" };
    if (isWindows()) return { paddingRight: `${WINDOWS_CAPTION_WIDTH_PX}px` };
    return EMPTY;
  }, [isFullscreen]);

  return (
    <WindowControlsInsetContext.Provider value={inset}>
      <TitleBarSurfaceContext.Provider value={onSeverityChange ?? null}>
        {children}
      </TitleBarSurfaceContext.Provider>
    </WindowControlsInsetContext.Provider>
  );
}
