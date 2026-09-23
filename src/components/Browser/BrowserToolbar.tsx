import { useState, useCallback, useRef, useEffect, useMemo, useId, type ReactNode } from "react";
import {
  ArrowLeft,
  ArrowRight,
  RotateCw,
  ExternalLink,
  Copy,
  Check,
  Globe,
  Lock,
  ZoomIn,
  ZoomOut,
  Camera,
  SquareTerminal,
  Code,
  Smartphone,
  PanelRight,
  EllipsisVertical,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { normalizeBrowserUrl, getDisplayUrl } from "./browserUtils";
import type { NormalizeResult } from "./browserUtils";
import { actionService } from "@/services/ActionService";
import { useUrlHistoryStore, getFrecencySuggestions } from "@/store/urlHistoryStore";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ViewportControls } from "./ViewportControls";
import type { ViewportPresetId } from "@shared/types/panel";
import type {
  BrowserNavigationHistoryEntry,
  BrowserNavigationHistorySnapshot,
} from "@shared/types/browser";
import { logError } from "@/utils/logger";
import { useResizeObserverRaf } from "@/hooks/useResizeObserverRaf";

const LONG_PRESS_MS = 400;
const COMPACT_ROW_WIDTH = 640;
const COPIED_FEEDBACK_RESET_MS = 2000;

const ZOOM_PRESETS = [
  { value: 0.25, label: "25%" },
  { value: 0.5, label: "50%" },
  { value: 0.75, label: "75%" },
  { value: 1.0, label: "100%" },
  { value: 1.25, label: "125%" },
  { value: 1.5, label: "150%" },
  { value: 2.0, label: "200%" },
];
const ZOOM_VALUES = ZOOM_PRESETS.map((preset) => preset.value);
const EMPTY_ENTRIES: import("@shared/types/browser").UrlHistoryEntry[] = [];

interface BrowserToolbarProps {
  terminalId?: string;
  projectId?: string;
  url: string;
  canGoBack: boolean;
  canGoForward: boolean;
  backEntry?: BrowserNavigationHistoryEntry | null;
  forwardEntry?: BrowserNavigationHistoryEntry | null;
  navSnapshot?: BrowserNavigationHistorySnapshot | null;
  isLoading: boolean;
  zoomFactor?: number;
  isConsoleOpen?: boolean;
  // Whether each action can do anything right now. The caller owns the predicate
  // so it stays next to the handler's own guard (#12395).
  canOpenExternal: boolean;
  canToggleConsole?: boolean;
  isWebviewReady?: boolean;
  viewportPreset?: ViewportPresetId;
  viewportRotated?: boolean;
  viewportDpr?: 1 | 2 | 3;
  viewportFit?: boolean;
  validateUrl?: (url: string) => NormalizeResult;
  /**
   * The address a person sees, edits and copies for `url`, when that differs from
   * the URL the webview is on (the dev preview's proxy origin). History entries go
   * through it too. Navigation still takes whatever `validateUrl` returns.
   */
  toAddress?: (url: string) => string;
  onNavigate: (url: string) => void;
  onBack: () => void;
  onForward: () => void;
  onGoToHistoryIndex?: (index: number) => void;
  onReload: () => void;
  /** Cancels an in-flight load; while loading, Reload becomes Stop. */
  onStop?: () => void;
  onHardReload?: () => void;
  onOpenExternal: () => void;
  onPromoteToPortal?: () => void;
  onZoomChange?: (zoomFactor: number) => void;
  onCaptureScreenshot?: () => Promise<boolean>;
  onToggleConsole?: () => void;
  onToggleDevTools?: () => void;
  onViewportPresetChange?: (preset: ViewportPresetId | undefined) => void;
  onViewportRotateToggle?: () => void;
  onViewportDprChange?: (dpr: 1 | 2 | 3) => void;
  onViewportFitToggle?: () => void;
  /** Buttons the host adds after the address bar, before the page actions (dev preview tools). */
  extraActions?: ReactNode;
}

export function BrowserToolbar({
  terminalId,
  projectId,
  url,
  canGoBack,
  canGoForward,
  backEntry,
  forwardEntry,
  navSnapshot,
  isLoading,
  zoomFactor = 1.0,
  isConsoleOpen = false,
  canOpenExternal,
  canToggleConsole = false,
  isWebviewReady = false,
  viewportPreset,
  viewportRotated = false,
  viewportDpr = 1,
  viewportFit = false,
  extraActions,
  validateUrl,
  toAddress,
  onNavigate,
  onBack,
  onForward,
  onGoToHistoryIndex,
  onReload,
  onStop,
  onHardReload,
  onOpenExternal,
  onPromoteToPortal,
  onZoomChange,
  onCaptureScreenshot,
  onToggleConsole,
  onToggleDevTools,
  onViewportPresetChange,
  onViewportRotateToggle,
  onViewportDprChange,
  onViewportFitToggle,
}: BrowserToolbarProps) {
  const address = toAddress ? toAddress(url) : url;
  const [inputValue, setInputValue] = useState(getDisplayUrl(address));
  const [isEditing, setIsEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectOnFocusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [screenshotCopied, setScreenshotCopied] = useState(false);
  const screenshotCopiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [historyAnnouncement, setHistoryAnnouncement] = useState("");

  // Long-press state for back/forward history dropdown
  const [longPressDir, setLongPressDir] = useState<"back" | "forward" | null>(null);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressTargetRef = useRef<"back" | "forward" | null>(null);
  const longPressDropdownRef = useRef<HTMLDivElement>(null);

  const clearLongPress = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    longPressTargetRef.current = null;
  }, []);

  const handlePointerDown = useCallback((dir: "back" | "forward", e: React.PointerEvent) => {
    if (e.button !== 0) return;
    longPressTargetRef.current = dir;
    longPressTimerRef.current = setTimeout(() => {
      if (longPressTargetRef.current === dir) {
        setLongPressDir(dir);
      }
    }, LONG_PRESS_MS);
  }, []);

  const handlePointerUp = useCallback(
    (dir: "back" | "forward", e: React.PointerEvent) => {
      if (e.button !== 0) return;
      if (longPressDir === dir) {
        // Dropdown is open — don't navigate
        clearLongPress();
        return;
      }
      clearLongPress();
      if (dir === "back") {
        onBack();
      } else {
        onForward();
      }
    },
    [longPressDir, clearLongPress, onBack, onForward]
  );

  // Close dropdown on click outside
  useEffect(() => {
    if (!longPressDir) return;
    const handleClick = (e: MouseEvent) => {
      if (longPressDropdownRef.current?.contains(e.target as Node)) return;
      setLongPressDir(null);
    };
    document.addEventListener("mousedown", handleClick, true);
    return () => document.removeEventListener("mousedown", handleClick, true);
  }, [longPressDir]);

  // Every timer this component schedules has to die with it: a feedback reset
  // that outlives the mount sets state on a gone tree, and under vitest it can
  // fire after the jsdom environment is torn down ("window is not defined").
  useEffect(() => {
    return () => {
      if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
      if (screenshotCopiedTimerRef.current) clearTimeout(screenshotCopiedTimerRef.current);
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
      if (selectOnFocusTimerRef.current) clearTimeout(selectOnFocusTimerRef.current);
    };
  }, []);

  // Recent entries for the dropdown (back shows past, forward shows future).
  // Use entry.index vs activeIndex so filtered entries don't shift positions.
  const recentBackEntries = useMemo(() => {
    if (!navSnapshot) return [];
    return navSnapshot.entries
      .filter((e) => e.index < navSnapshot.activeIndex)
      .sort((a, b) => b.index - a.index);
  }, [navSnapshot]);

  const recentForwardEntries = useMemo(() => {
    if (!navSnapshot) return [];
    return navSnapshot.entries
      .filter((e) => e.index > navSnapshot.activeIndex)
      .sort((a, b) => a.index - b.index);
  }, [navSnapshot]);

  const backTooltip = backEntry?.title || (canGoBack ? "Go back" : "");
  const forwardTooltip = forwardEntry?.title || (canGoForward ? "Go forward" : "");

  const announceHistoryChange = useCallback((text: string) => {
    // ZWSP toggle forces re-announce when consecutive removals share a display URL
    // eslint-disable-next-line no-irregular-whitespace
    setHistoryAnnouncement((prev) => (prev === text ? `${text}​` : text));
  }, []);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const lastViewportPresetRef = useRef<ViewportPresetId>("iphone");
  // Below this width the row keeps the route readable by moving Copy URL and the
  // console toggle into More, rather than letting the address shrink to nothing.
  const [rowElement, setRowElement] = useState<HTMLDivElement | null>(null);
  const [isCompact, setIsCompact] = useState(false);
  useResizeObserverRaf(rowElement, (entry) => {
    setIsCompact(entry.contentRect.width < COMPACT_ROW_WIDTH);
  });
  const [isZoomPopoverOpen, setIsZoomPopoverOpen] = useState(false);
  const copyButtonRef = useRef<HTMLButtonElement>(null);
  const errorId = useId();
  const listboxId = useId();

  const projectEntries = useUrlHistoryStore(
    (state) => (projectId ? state.entries[projectId] : undefined) ?? EMPTY_ENTRIES
  );

  // Matched against the address people see and type, never the URL underneath:
  // a dev preview's history is stored on its proxy origin, and "localhost:5173/da"
  // has to find the dashboard. Rows keep the stored URL for navigation and removal.
  const suggestions = useMemo(() => {
    if (!isEditing || !projectId) return [];
    if (!toAddress) return getFrecencySuggestions(projectEntries, inputValue);
    const byAddress = new Map(projectEntries.map((entry) => [toAddress(entry.url), entry]));
    const shown = projectEntries.map((entry) => ({ ...entry, url: toAddress(entry.url) }));
    return getFrecencySuggestions(shown, inputValue).flatMap(
      (entry) => byAddress.get(entry.url) ?? []
    );
  }, [isEditing, projectId, projectEntries, inputValue, toAddress]);
  const addressOf = useCallback(
    (target: string) => getDisplayUrl(toAddress ? toAddress(target) : target),
    [toAddress]
  );

  useEffect(() => {
    setHighlightedIndex(-1);
    setIsDropdownOpen(isEditing && suggestions.length > 0);
  }, [suggestions, isEditing]);

  useEffect(() => {
    if (viewportPreset) lastViewportPresetRef.current = viewportPreset;
  }, [viewportPreset]);

  useEffect(() => {
    if (!isEditing) {
      setInputValue(getDisplayUrl(address));
    }
  }, [address, isEditing]);

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const result = validateUrl ? validateUrl(inputValue) : normalizeBrowserUrl(inputValue);
      if (result.error) {
        setError(result.error);
        setIsDropdownOpen(false);
        setHighlightedIndex(-1);
        return;
      }
      if (result.url) {
        setError(null);
        setIsEditing(false);
        setIsDropdownOpen(false);
        setHighlightedIndex(-1);
        if (result.url === url) {
          onReload();
        } else {
          onNavigate(result.url);
        }
      }
    },
    [inputValue, url, onNavigate, onReload, validateUrl]
  );

  const handleFocus = useCallback(() => {
    setIsEditing(true);
    setInputValue(address);
    if (selectOnFocusTimerRef.current) clearTimeout(selectOnFocusTimerRef.current);
    selectOnFocusTimerRef.current = setTimeout(() => inputRef.current?.select(), 0);
  }, [address]);

  const handleBlur = useCallback(
    (e: React.FocusEvent) => {
      if (dropdownRef.current?.contains(e.relatedTarget as Node)) return;
      setIsEditing(false);
      setIsDropdownOpen(false);
      setHighlightedIndex(-1);
      setError(null);
      setInputValue(getDisplayUrl(address));
    },
    [address]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (isDropdownOpen && suggestions.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setHighlightedIndex((i) => Math.min(i + 1, suggestions.length - 1));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setHighlightedIndex((i) => Math.max(i - 1, -1));
          return;
        }
        if (e.key === "Enter" && highlightedIndex >= 0) {
          e.preventDefault();
          const selected = suggestions[highlightedIndex]!;
          setIsEditing(false);
          setIsDropdownOpen(false);
          setHighlightedIndex(-1);
          onNavigate(selected.url);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setIsDropdownOpen(false);
          setHighlightedIndex(-1);
          return;
        }
        if (e.shiftKey && (e.key === "Delete" || e.key === "Backspace") && highlightedIndex >= 0) {
          e.preventDefault();
          const entry = suggestions[highlightedIndex]!;
          if (projectId) {
            useUrlHistoryStore.getState().removeUrl(projectId, entry.url);
          }
          announceHistoryChange(`Removed ${addressOf(entry.url)} from history`);
          const remaining = suggestions.length - 1;
          if (remaining === 0) {
            setIsDropdownOpen(false);
            setHighlightedIndex(-1);
          } else if (highlightedIndex >= remaining) {
            setHighlightedIndex(remaining - 1);
          }
          return;
        }
      }
      if (e.key === "Escape") {
        setIsEditing(false);
        setError(null);
        inputRef.current?.blur();
      }
    },
    [
      isDropdownOpen,
      suggestions,
      highlightedIndex,
      onNavigate,
      projectId,
      announceHistoryChange,
      addressOf,
    ]
  );

  const handleCopy = useCallback(async () => {
    try {
      const result = await actionService.dispatch(
        "browser.copyUrl",
        { terminalId, url: address },
        { source: "user" }
      );
      if (!result.ok) {
        throw new Error(result.error.message);
      }
      setCopied(true);
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = setTimeout(() => setCopied(false), COPIED_FEEDBACK_RESET_MS);
    } catch (err) {
      logError("Failed to copy URL", err);
    }
  }, [terminalId, address]);

  const handleCaptureScreenshot = useCallback(async () => {
    if (!onCaptureScreenshot) return;
    let success = false;
    try {
      success = await onCaptureScreenshot();
    } catch (err) {
      logError("Failed to capture screenshot", err);
    }
    if (screenshotCopiedTimerRef.current) clearTimeout(screenshotCopiedTimerRef.current);
    if (!success) {
      setScreenshotCopied(false);
      return;
    }
    setScreenshotCopied(true);
    screenshotCopiedTimerRef.current = setTimeout(
      () => setScreenshotCopied(false),
      COPIED_FEEDBACK_RESET_MS
    );
  }, [onCaptureScreenshot]);

  const handleZoomStep = useCallback(
    (direction: "in" | "out") => {
      if (!onZoomChange) return;
      const minZoom = ZOOM_VALUES[0]!;
      const maxZoom = ZOOM_VALUES[ZOOM_VALUES.length - 1]!;
      const clampedZoom = Math.max(minZoom, Math.min(maxZoom, zoomFactor));
      const exactIndex = ZOOM_VALUES.findIndex((value) => Math.abs(value - clampedZoom) < 0.01);
      let nextZoom: number;

      if (exactIndex !== -1) {
        const nextIndex =
          direction === "in"
            ? Math.min(exactIndex + 1, ZOOM_VALUES.length - 1)
            : Math.max(exactIndex - 1, 0);
        nextZoom = ZOOM_VALUES[nextIndex]!;
      } else if (direction === "in") {
        nextZoom = ZOOM_VALUES.find((value) => value > clampedZoom) ?? maxZoom;
      } else {
        const lowerValues = ZOOM_VALUES.filter((value) => value < clampedZoom);
        nextZoom = lowerValues.length > 0 ? lowerValues[lowerValues.length - 1]! : minZoom;
      }

      if (Math.abs(nextZoom - zoomFactor) >= 0.001) {
        onZoomChange(nextZoom);
      }
    },
    [onZoomChange, zoomFactor]
  );

  const handleZoomReset = useCallback(() => {
    if (!onZoomChange) return;
    if (Math.abs(zoomFactor - 1.0) < 0.01) return;
    onZoomChange(1.0);
  }, [onZoomChange, zoomFactor]);

  const isNonDefaultZoom = Math.abs(zoomFactor - 1.0) >= 0.01;
  const currentZoomLabel =
    ZOOM_PRESETS.find((p) => Math.abs(p.value - zoomFactor) < 0.01)?.label ??
    `${Math.round(zoomFactor * 100)}%`;
  const minZoom = ZOOM_VALUES[0]!;
  const maxZoom = ZOOM_VALUES[ZOOM_VALUES.length - 1]!;
  const canZoomOut = zoomFactor > minZoom + 0.001;
  const canZoomIn = zoomFactor < maxZoom - 0.001;

  const isHttps = useMemo(() => {
    try {
      return new URL(url).protocol === "https:";
    } catch {
      return false;
    }
  }, [url]);

  const buttonClass =
    "toolbar-icon-button shrink-0 p-1.5 rounded-[var(--radius-md)] disabled:opacity-30 disabled:cursor-not-allowed";
  const actionClass = cn(buttonClass, "text-text-secondary aria-pressed:text-text-primary");

  // The stored preference survives the dev server stopping, but with no terminal
  // behind it there is no drawer to show, so the toggle must not read as pressed.
  const isConsoleShown = canToggleConsole && isConsoleOpen;
  const showStop = isLoading && Boolean(onStop);
  const consoleInMenu = isCompact && Boolean(onToggleConsole);
  const hasMoreMenu = Boolean(onZoomChange || onToggleDevTools || onPromoteToPortal || isCompact);
  // The chip stays while its popover is open, so stepping through 100% keeps the
  // controls under the pointer; it goes once the popover closes at the default.
  const showZoomChip = Boolean(onZoomChange) && (isNonDefaultZoom || isZoomPopoverOpen);

  // The resting address reads host-then-route, with the route carrying the weight:
  // the host is the same on every page of a dev server, the route is what changed.
  const displayText = getDisplayUrl(address);
  const slashAt = displayText.search(/[/?#]/);
  const displayHost = slashAt === -1 ? displayText : displayText.slice(0, slashAt);
  const displayRoute = slashAt === -1 ? "" : displayText.slice(slashAt);
  const showStyledAddress = !isEditing && Boolean(displayText);

  // A disabled button receives no pointer events, so its tooltip needs a wrapper to
  // hover. Only while disabled: focus-restore suppression marks the focused element,
  // and an enabled button wrapped in a span would never match its own trigger.
  const consoleButton = (
    <button
      type="button"
      onClick={onToggleConsole}
      disabled={!canToggleConsole}
      className={cn(actionClass, "disabled:pointer-events-none")}
      aria-label="Toggle console"
      aria-pressed={isConsoleShown}
    >
      <SquareTerminal className="w-4 h-4" />
    </button>
  );
  const openExternalButton = (
    <button
      type="button"
      onClick={onOpenExternal}
      disabled={!canOpenExternal}
      className={cn(actionClass, "disabled:pointer-events-none")}
      aria-label="Open in browser"
    >
      <ExternalLink className="w-4 h-4" />
    </button>
  );

  const historyMenu = (dir: "back" | "forward") => {
    const entries = dir === "back" ? recentBackEntries : recentForwardEntries;
    if (longPressDir !== dir || entries.length === 0) return null;
    return (
      <div
        ref={longPressDropdownRef}
        className="absolute left-0 top-full mt-1 z-50 min-w-[220px] rounded-[var(--radius-lg)] surface-overlay shadow-overlay overflow-hidden"
      >
        {entries.map((entry) => (
          <button
            key={entry.index}
            type="button"
            onMouseDown={(e) => {
              e.preventDefault();
              setLongPressDir(null);
              onGoToHistoryIndex?.(entry.index);
            }}
            className="w-full text-left px-2.5 py-1.5 hover:bg-overlay-medium transition-colors flex flex-col gap-0.5"
          >
            <span className="text-xs text-text-primary truncate">{entry.title || entry.url}</span>
            <span className="text-2xs text-text-secondary truncate">{entry.url}</span>
          </button>
        ))}
      </div>
    );
  };

  const navButton = (dir: "back" | "forward") => {
    const enabled = dir === "back" ? canGoBack : canGoForward;
    const tooltip = dir === "back" ? backTooltip || "Go back" : forwardTooltip || "Go forward";
    return (
      <div className="relative">
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex">
              <button
                type="button"
                onPointerDown={(e) => handlePointerDown(dir, e)}
                onPointerUp={(e) => handlePointerUp(dir, e)}
                onPointerLeave={clearLongPress}
                onPointerCancel={clearLongPress}
                // Pointer presses navigate on pointer-up so a long press can open
                // history instead; Enter and Space only ever produce a click.
                onClick={(e) => {
                  if (e.detail !== 0) return;
                  if (dir === "back") onBack();
                  else onForward();
                }}
                disabled={!enabled}
                className={cn(buttonClass, "disabled:pointer-events-none")}
                aria-label={tooltip}
                data-testid={dir === "back" ? "browser-back" : "browser-forward"}
              >
                {dir === "back" ? (
                  <ArrowLeft className="w-4 h-4" />
                ) : (
                  <ArrowRight className="w-4 h-4" />
                )}
              </button>
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom">{tooltip}</TooltipContent>
        </Tooltip>
        {historyMenu(dir)}
      </div>
    );
  };

  const zoomStepper = (
    <div className="flex items-center gap-0.5">
      <button
        type="button"
        onClick={() => handleZoomStep("out")}
        disabled={!canZoomOut}
        className={cn(buttonClass, "p-1")}
        aria-label="Zoom out"
      >
        <ZoomOut className="w-4 h-4" />
      </button>
      <span className="min-w-12 px-1 text-center text-xs font-medium tabular-nums text-text-primary">
        {currentZoomLabel}
      </span>
      <button
        type="button"
        onClick={() => handleZoomStep("in")}
        disabled={!canZoomIn}
        className={cn(buttonClass, "p-1")}
        aria-label="Zoom in"
      >
        <ZoomIn className="w-4 h-4" />
      </button>
      <button
        type="button"
        onClick={handleZoomReset}
        disabled={!isNonDefaultZoom}
        className="toolbar-icon-button ml-1 px-2 py-1 rounded-[var(--radius-md)] text-xs font-medium text-text-primary disabled:opacity-40"
        aria-label="Reset zoom"
      >
        Reset
      </button>
    </div>
  );

  return (
    <div data-testid="browser-toolbar" className="bg-surface border-b border-overlay">
      <span role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {historyAnnouncement}
      </span>
      <span role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {copied ? "Copied to clipboard" : ""}
      </span>
      <span role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {screenshotCopied ? "Screenshot copied to clipboard" : ""}
      </span>
      <div ref={setRowElement} className="flex items-center gap-2 px-2 py-1.5">
        <div className="flex shrink-0 items-center gap-0.5">
          {navButton("back")}
          {navButton("forward")}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={(e) => {
                  if (showStop) {
                    onStop?.();
                  } else if (e.shiftKey && onHardReload) {
                    onHardReload();
                  } else {
                    onReload();
                  }
                }}
                className={buttonClass}
                aria-label={showStop ? "Stop loading" : "Reload"}
                data-testid="browser-reload"
              >
                {showStop ? <X className="w-4 h-4" /> : <RotateCw className="w-4 h-4" />}
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {showStop
                ? "Stop loading"
                : onHardReload
                  ? "Reload (Shift+click for hard reload)"
                  : "Reload"}
            </TooltipContent>
          </Tooltip>
        </div>

        {/* Address */}
        <div ref={containerRef} className="relative flex-1 min-w-36">
          <form onSubmit={handleSubmit}>
            <div className="relative flex items-center">
              {isHttps ? (
                <Lock
                  data-testid="browser-url-scheme-lock"
                  aria-hidden="true"
                  className="absolute left-2 w-3.5 h-3.5 text-text-secondary pointer-events-none"
                />
              ) : (
                <Globe
                  data-testid="browser-url-scheme-globe"
                  aria-hidden="true"
                  className="absolute left-2 w-3.5 h-3.5 text-text-secondary pointer-events-none"
                />
              )}
              <input
                ref={inputRef}
                type="text"
                data-testid="browser-address-bar"
                role="combobox"
                aria-label="Address bar"
                aria-autocomplete="list"
                aria-expanded={isDropdownOpen}
                aria-controls={listboxId}
                aria-activedescendant={
                  isDropdownOpen && highlightedIndex >= 0
                    ? `${listboxId}-option-${highlightedIndex}`
                    : undefined
                }
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? errorId : undefined}
                value={inputValue}
                onChange={(e) => {
                  setInputValue(e.target.value);
                  setError(null);
                }}
                onFocus={handleFocus}
                onBlur={handleBlur}
                onKeyDown={handleKeyDown}
                autoComplete="off"
                spellCheck={false}
                className={cn(
                  "w-full h-7 pl-7 text-xs rounded-[var(--radius-md)]",
                  showZoomChip ? (isCompact ? "pr-16" : "pr-20") : isCompact ? "pr-2" : "pr-8",
                  "bg-surface-canvas border border-overlay",
                  "focus:outline-hidden focus:border-border-strong",
                  "focus-visible:outline-solid focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2",
                  "text-text-primary placeholder:text-text-placeholder",
                  showStyledAddress && "text-transparent",
                  error &&
                    "border-status-error focus:border-status-error focus-visible:outline-status-error"
                )}
                placeholder="localhost:3000"
              />
              {showStyledAddress && (
                <div
                  aria-hidden="true"
                  data-testid="browser-address-display"
                  className={cn(
                    "pointer-events-none absolute inset-y-0 left-7 flex items-center min-w-0 text-xs",
                    showZoomChip
                      ? isCompact
                        ? "right-16"
                        : "right-20"
                      : isCompact
                        ? "right-2"
                        : "right-8"
                  )}
                >
                  {!(isCompact && displayRoute) && (
                    <span
                      className={cn(
                        "min-w-0 truncate [flex-shrink:1000]",
                        displayRoute ? "text-text-secondary" : "text-text-primary"
                      )}
                    >
                      {displayHost}
                    </span>
                  )}
                  {displayRoute && (
                    <span className="min-w-0 truncate text-left text-text-primary [direction:rtl]">
                      <bdi>{displayRoute}</bdi>
                    </span>
                  )}
                </div>
              )}
              <div className="absolute right-0.5 flex items-center gap-0.5">
                {showZoomChip && (
                  <Popover open={isZoomPopoverOpen} onOpenChange={setIsZoomPopoverOpen}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <PopoverTrigger asChild>
                          <button
                            type="button"
                            className="toolbar-icon-button flex h-6 items-center gap-1 px-1.5 rounded-[var(--radius-sm)] text-2xs font-medium tabular-nums text-text-primary"
                            aria-label={`Zoom ${currentZoomLabel}`}
                            data-testid="browser-zoom-indicator"
                          >
                            {zoomFactor < 1 ? (
                              <ZoomOut className="w-3 h-3 text-text-secondary" aria-hidden="true" />
                            ) : (
                              <ZoomIn className="w-3 h-3 text-text-secondary" aria-hidden="true" />
                            )}
                            {currentZoomLabel}
                          </button>
                        </PopoverTrigger>
                      </TooltipTrigger>
                      <TooltipContent side="bottom">Zoom</TooltipContent>
                    </Tooltip>
                    <PopoverContent
                      align="end"
                      className="w-auto p-1"
                      onCloseAutoFocus={(e) => {
                        // Back at 100% the chip is about to unmount; hand focus to
                        // its neighbour instead of letting it fall to the body.
                        if (isNonDefaultZoom) return;
                        e.preventDefault();
                        copyButtonRef.current?.focus({ preventScroll: true });
                      }}
                    >
                      {zoomStepper}
                    </PopoverContent>
                  </Popover>
                )}
                {!isCompact && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        ref={copyButtonRef}
                        type="button"
                        onClick={handleCopy}
                        disabled={!address}
                        className="toolbar-icon-button flex h-6 w-6 items-center justify-center rounded-[var(--radius-sm)] text-text-secondary disabled:opacity-30 disabled:pointer-events-none"
                        aria-label="Copy URL"
                      >
                        {copied ? (
                          <Check className="w-3.5 h-3.5 text-status-success" />
                        ) : (
                          <Copy className="w-3.5 h-3.5" />
                        )}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">Copy URL</TooltipContent>
                  </Tooltip>
                )}
              </div>
            </div>
            {error && (
              <div
                id={errorId}
                role="alert"
                className="absolute left-0 mt-1 max-w-full text-xs text-status-error surface-overlay shadow-overlay border border-status-error rounded-[var(--radius-md)] px-2 py-1 z-10"
              >
                {error}
              </div>
            )}
          </form>

          {isDropdownOpen && suggestions.length > 0 && (
            <div
              ref={dropdownRef}
              id={listboxId}
              role="listbox"
              className="absolute left-0 right-0 top-full mt-1 z-50 rounded-[var(--radius-lg)] surface-overlay shadow-overlay overflow-hidden"
            >
              {suggestions.map((entry, index) => {
                const entryAddress = addressOf(entry.url);
                return (
                  <div
                    key={entry.url}
                    id={`${listboxId}-option-${index}`}
                    role="option"
                    aria-selected={index === highlightedIndex}
                    onMouseEnter={() => setHighlightedIndex(index)}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      setIsEditing(false);
                      setIsDropdownOpen(false);
                      setHighlightedIndex(-1);
                      onNavigate(entry.url);
                    }}
                    className={cn(
                      "group/row w-full text-left px-2.5 py-1.5 flex items-center gap-2 cursor-pointer",
                      index === highlightedIndex ? "bg-overlay-medium" : "hover:bg-overlay-soft"
                    )}
                  >
                    {entry.favicon ? (
                      <span className="relative w-4 h-4 shrink-0">
                        <img
                          src={entry.favicon}
                          alt=""
                          className="w-4 h-4 rounded-[var(--radius-sm)] object-contain"
                          onError={(e) => {
                            const img = e.target as HTMLImageElement;
                            img.style.display = "none";
                            const fallback = img.nextElementSibling;
                            if (fallback) (fallback as HTMLElement).style.display = "";
                          }}
                        />
                        <Globe
                          className="w-4 h-4 text-text-secondary absolute inset-0"
                          style={{ display: "none" }}
                        />
                      </span>
                    ) : (
                      <Globe className="w-4 h-4 shrink-0 text-text-secondary" />
                    )}
                    <div className="flex-1 min-w-0 flex flex-col gap-0.5 text-left">
                      {entry.title && (
                        <span className="text-xs text-text-primary truncate">{entry.title}</span>
                      )}
                      <span className="text-xs text-text-secondary truncate">{entryAddress}</span>
                    </div>
                    {projectId && (
                      <button
                        type="button"
                        tabIndex={-1}
                        aria-hidden="true"
                        onMouseDown={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          useUrlHistoryStore.getState().removeUrl(projectId, entry.url);
                          announceHistoryChange(`Removed ${entryAddress} from history`);
                          const remaining = suggestions.length - 1;
                          if (remaining === 0) {
                            setIsDropdownOpen(false);
                            setHighlightedIndex(-1);
                          } else if (index === highlightedIndex && highlightedIndex >= remaining) {
                            setHighlightedIndex(remaining - 1);
                          }
                        }}
                        className="shrink-0 p-0.5 rounded-[var(--radius-sm)] opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100 hover:bg-overlay-strong transition-opacity text-text-secondary hover:text-text-primary"
                        aria-label={`Remove ${entryAddress} from history`}
                      >
                        <X className="w-3 h-3" />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Tools that look into the page */}
        <div className="flex shrink-0 items-center gap-0.5">
          {extraActions}
          {onViewportPresetChange && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => {
                    if (viewportPreset) {
                      onViewportPresetChange(undefined);
                    } else {
                      onViewportPresetChange(lastViewportPresetRef.current);
                    }
                  }}
                  className={actionClass}
                  aria-label="Device mode"
                  aria-pressed={!!viewportPreset}
                >
                  <Smartphone className="w-4 h-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {viewportPreset ? "Exit device mode" : "Preview on a device"}
              </TooltipContent>
            </Tooltip>
          )}
          {onToggleConsole && !consoleInMenu && (
            <Tooltip>
              <TooltipTrigger asChild>
                {canToggleConsole ? (
                  consoleButton
                ) : (
                  <span className="inline-flex">{consoleButton}</span>
                )}
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {isConsoleShown ? "Hide console" : "Show console"}
              </TooltipContent>
            </Tooltip>
          )}
        </div>

        {/* Taking the page somewhere else */}
        <div className="flex shrink-0 items-center gap-0.5">
          {onCaptureScreenshot && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={handleCaptureScreenshot}
                  disabled={!isWebviewReady}
                  className={cn(
                    actionClass,
                    "disabled:hover:bg-transparent disabled:hover:shadow-none"
                  )}
                  aria-label="Copy screenshot to clipboard"
                >
                  {screenshotCopied ? (
                    <Check className="w-4 h-4 text-status-success" />
                  ) : (
                    <Camera className="w-4 h-4" />
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Copy screenshot to clipboard</TooltipContent>
            </Tooltip>
          )}

          <Tooltip>
            <TooltipTrigger asChild>
              {canOpenExternal ? (
                openExternalButton
              ) : (
                <span className="inline-flex">{openExternalButton}</span>
              )}
            </TooltipTrigger>
            <TooltipContent side="bottom">Open in browser</TooltipContent>
          </Tooltip>

          {hasMoreMenu && (
            <DropdownMenu>
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      className={actionClass}
                      aria-label="More page actions"
                      data-testid="browser-more-actions"
                    >
                      <EllipsisVertical className="w-4 h-4" />
                    </button>
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent side="bottom">More page actions</TooltipContent>
              </Tooltip>
              <DropdownMenuContent align="end" className="min-w-[200px]">
                {isCompact && (
                  <>
                    <DropdownMenuItem disabled={!address} onSelect={() => void handleCopy()}>
                      <Copy className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
                      Copy URL
                    </DropdownMenuItem>
                    {consoleInMenu && (
                      <DropdownMenuCheckboxItem
                        checked={isConsoleShown}
                        disabled={!canToggleConsole}
                        onSelect={() => onToggleConsole?.()}
                      >
                        Console
                      </DropdownMenuCheckboxItem>
                    )}
                    {(onZoomChange || onToggleDevTools || onPromoteToPortal) && (
                      <DropdownMenuSeparator />
                    )}
                  </>
                )}
                {onZoomChange && (
                  <>
                    <DropdownMenuLabel className="flex items-center justify-between">
                      Zoom
                      <span className="tabular-nums text-text-secondary">{currentZoomLabel}</span>
                    </DropdownMenuLabel>
                    <DropdownMenuItem
                      disabled={!canZoomIn}
                      onSelect={(e) => {
                        e.preventDefault();
                        handleZoomStep("in");
                      }}
                    >
                      <ZoomIn className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
                      Zoom in
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={!canZoomOut}
                      onSelect={(e) => {
                        e.preventDefault();
                        handleZoomStep("out");
                      }}
                    >
                      <ZoomOut className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
                      Zoom out
                    </DropdownMenuItem>
                    <DropdownMenuItem disabled={!isNonDefaultZoom} onSelect={handleZoomReset}>
                      <span className="w-3.5 mr-2" aria-hidden="true" />
                      Actual size
                    </DropdownMenuItem>
                  </>
                )}
                {onZoomChange && (onToggleDevTools || onPromoteToPortal) && (
                  <DropdownMenuSeparator />
                )}
                {onToggleDevTools && (
                  <DropdownMenuItem disabled={!isWebviewReady} onSelect={onToggleDevTools}>
                    <Code className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
                    Toggle DevTools
                  </DropdownMenuItem>
                )}
                {onPromoteToPortal && (
                  <DropdownMenuItem
                    onSelect={onPromoteToPortal}
                    data-testid="browser-promote-portal"
                  >
                    <PanelRight className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
                    Open in Portal
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>

      {viewportPreset && onViewportPresetChange && (
        <ViewportControls
          preset={viewportPreset}
          rotated={viewportRotated}
          dpr={viewportDpr}
          fit={viewportFit}
          onPresetChange={onViewportPresetChange}
          onRotateToggle={onViewportRotateToggle}
          onDprChange={onViewportDprChange}
          onFitToggle={onViewportFitToggle}
        />
      )}
    </div>
  );
}
