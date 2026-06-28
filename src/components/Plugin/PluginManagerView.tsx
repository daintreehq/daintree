import {
  Package,
  FilePlus,
  Link2,
  Info,
  Download,
  AlertCircle,
  AlertTriangle,
  ChevronLeft,
  X,
} from "lucide-react";
import { useState, useEffect, useRef, useMemo, useDeferredValue } from "react";
import { createPortal } from "react-dom";
import { SettingsSwitch } from "@/components/Settings/SettingsSwitch";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { AppDialog } from "@/components/ui/AppDialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { ScrollShadow } from "@/components/ui/ScrollShadow";
import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
import { usePluginManagerStore } from "@/store/pluginManagerStore";
import { useOverlayClaim } from "@/hooks";
import { useEscapeStack } from "@/hooks/useEscapeStack";
import { logError } from "@/utils/logger";
import { cn } from "@/lib/utils";
import { isMac, isWindows } from "@/lib/platform";
import { usePluginManager } from "./usePluginManager";
import { PluginDetailPane, SOURCE_BADGE_LABELS, pluginLabel } from "./PluginDetailPane";
import { PluginCatalog } from "./PluginCatalog";
import { PluginIconTile } from "./pluginIcons";
import { groupPluginsByCategory } from "./pluginGrouping";
import { filterPlugins, isQueryActive, parsePluginQuery } from "@/lib/pluginSearch";
import { PLUGIN_CATEGORIES } from "@shared/config/pluginCategoryRegistry";
import type { LoadedPluginInfo, PluginDeepLinkIntent } from "@shared/types/plugin";

const ROW_BADGE_CLASS =
  "inline-flex items-center px-1.5 py-0.5 rounded-sm text-[10px] font-medium bg-overlay-subtle border border-daintree-border/50 text-daintree-text/60 uppercase tracking-wide";

// Disabled-option separator class for section headers inside the listbox.
// role="group" inside role="listbox" is broken under Chromium 146 + VoiceOver
// (LESSON #9006), so headers masquerade as non-interactive options instead.
const SECTION_HEADER_CLASS =
  "px-3 text-[10px] font-medium uppercase tracking-wider text-daintree-text/40 select-none";

// Operator chips surfaced below the search input so the filter syntax is
// discoverable instead of hidden. Categories are the headline filters; the
// provenance/state tokens (`@builtin`, `@installed`, `@enabled`) and
// `@cap:<value>` stay typeable but don't earn a chip. "Other" is omitted —
// chips advertise the catalog's shape, not its fallback bucket.
const PLUGIN_FILTER_CHIPS: ReadonlyArray<{ token: string; label: string }> = [
  ...PLUGIN_CATEGORIES.filter((c) => c.id !== "other").map((c) => ({
    token: `@cat:${c.id}`,
    label: c.label,
  })),
  { token: "@disabled", label: "Disabled" },
];

interface PluginRowProps {
  plugin: LoadedPluginInfo;
  selected: boolean;
  toggling: boolean;
  onSelect: () => void;
  onToggle: () => void;
  /** Attached to the row root so a deep-link `open` (#9559) can scroll it into view. */
  innerRef?: (el: HTMLDivElement | null) => void;
  /** Transient neutral highlight when a deep-link `open` targets this row. */
  highlighted?: boolean;
}

/**
 * One installed-plugin row in the master list (#9555): a compact, selectable
 * entry showing the plugin's icon tile, name, version, tagline, and the enable
 * toggle. Selecting it populates the detail pane on the right — the full
 * metadata, actions, and settings live there now, so the row stays scannable
 * and never shifts layout.
 *
 * A disabled plugin stays in its category section, dimmed in place with a
 * "Disabled" badge — the dominant pattern (VS Code, JetBrains, browsers) and
 * the one that preserves spatial memory; relocation to a quarantine section
 * was the old #9554 behavior. Provenance only earns a badge when it differs
 * from the catalog's default (non-builtin sources: file / URL / catalog).
 *
 * The selection target is a `<button role="option">` covering the info area;
 * the enable toggle is a sibling control (not nested) so it keeps its own click
 * target. Selected styling follows the master-detail precedent (`bg-overlay-soft`
 * + a single 2px accent bar via `before:*`), reserving the accent for the one
 * load-bearing selection signal.
 *
 * A deep-link `open` (#9559) scrolls the row into view via `innerRef` and flags
 * it with a transient neutral `highlighted` outline — distinct from the accent
 * selection stripe so the two signals never collide.
 */
function PluginRow({
  plugin,
  selected,
  toggling,
  onSelect,
  onToggle,
  innerRef,
  highlighted,
}: PluginRowProps) {
  const label = pluginLabel(plugin);
  const enabled = plugin.disabled !== true;
  const restartRequired = plugin.pendingRestart === true;
  const sourceLabel = SOURCE_BADGE_LABELS[plugin.source] ?? plugin.source;
  const tagline = plugin.manifest.tagline;

  return (
    <div
      ref={innerRef}
      className={cn(
        "relative flex items-center gap-2 rounded-[var(--radius-md)] border text-daintree-text transition-colors",
        selected
          ? "bg-overlay-soft border-overlay before:absolute before:left-0 before:top-2 before:bottom-2 before:w-[2px] before:rounded-r before:bg-daintree-accent before:content-['']"
          : highlighted
            ? "border-daintree-text/40 bg-overlay-subtle"
            : "border-transparent hover:bg-overlay-subtle"
      )}
    >
      <button
        type="button"
        role="option"
        aria-selected={selected}
        onClick={onSelect}
        className="flex items-start gap-2.5 min-w-0 flex-1 py-2.5 pl-3 pr-1 text-left rounded-[var(--radius-md)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent"
      >
        <PluginIconTile manifest={plugin.manifest} size="sm" dimmed={!enabled} />
        <span className="min-w-0">
          <span
            className={cn(
              "text-sm font-medium flex items-center gap-1.5 flex-wrap",
              !enabled && "text-daintree-text/50"
            )}
          >
            <span className="truncate">{label}</span>
            <span className="text-[11px] font-normal text-daintree-text/40">
              v{plugin.manifest.version}
            </span>
          </span>
          {tagline && (
            <span
              className={cn(
                "mt-0.5 block text-[11px] truncate",
                enabled ? "text-daintree-text/50" : "text-daintree-text/35"
              )}
            >
              {tagline}
            </span>
          )}
          {(!enabled ||
            !plugin.isBuiltin ||
            plugin.devMode ||
            restartRequired ||
            plugin.loadError) && (
            <span className="mt-1 flex items-center gap-1 flex-wrap">
              {!enabled && <span className={ROW_BADGE_CLASS}>Disabled</span>}
              {!plugin.isBuiltin && <span className={ROW_BADGE_CLASS}>{sourceLabel}</span>}
              {plugin.devMode && <span className={ROW_BADGE_CLASS}>Dev</span>}
              {restartRequired && (
                <span className={`${ROW_BADGE_CLASS} text-daintree-text/50`}>Restart required</span>
              )}
              {plugin.loadError && (
                <span className="inline-flex items-center gap-0.5 text-[10px] font-medium text-status-danger uppercase tracking-wide">
                  <AlertCircle className="w-3 h-3" aria-hidden="true" />
                  Failed
                </span>
              )}
            </span>
          )}
        </span>
      </button>

      <span className="shrink-0 pr-2.5">
        <SettingsSwitch
          checked={enabled}
          onCheckedChange={onToggle}
          disabled={toggling}
          aria-label={`Enable ${label}`}
        />
      </span>
    </div>
  );
}

function RowSkeleton() {
  return (
    <div className="w-full flex items-center gap-2.5 py-2.5 px-3 rounded-[var(--radius-md)]">
      <div className="flex items-center gap-2.5 w-full animate-pulse-delayed">
        <div className="w-4 h-4 rounded bg-daintree-text/10" />
        <div className="flex-1 space-y-2">
          <div className="h-3 w-24 rounded bg-daintree-text/10" />
          <div className="h-2 w-16 rounded bg-daintree-text/10" />
        </div>
        <div className="w-9 h-5 rounded-full bg-daintree-text/10" />
      </div>
    </div>
  );
}

interface PluginManagerViewProps {
  /** Pending `daintree://` deep-link intent (#9559), or `null` when none. */
  deepLinkIntent?: PluginDeepLinkIntent | null;
  /** Called once the intent has been applied so the source can clear it. */
  onDeepLinkConsumed?: () => void;
}

// How long the deep-link `open` target row stays highlighted before fading back.
const DEEP_LINK_HIGHLIGHT_MS = 2000;

/**
 * Dedicated plugin manager view (#9558) — the primary surface for plugin
 * lifecycle: install from file or URL (#9290), enable/disable (#9284),
 * uninstall, provenance, and the manual check-for-update flow (#9297). Graduated
 * out of the former `PluginManagerDialog` modal into a first-class full-screen
 * overlay modelled on VS Code's Extensions view: a master list on the left
 * (grouped by catalog category — see `PLUGIN_CATEGORIES`), and on the right
 * either the selected plugin's tabbed detail pane or the `PluginCatalog` home
 * (category card grid). It owns the full management UI lifted out of the former
 * Settings `PluginsTab`, which is now a thin entry point. Files can be dropped
 * anywhere on the body to install. The network-backed browse/discovery catalog
 * (#9305) ships separately — the master column reserves a footer slot for it
 * below the installed list.
 *
 * Visibility is driven by `usePluginManagerStore` (mirrors `themeBrowserStore`);
 * `AppLayout` reads the `plugin-manager` overlay claim to mark its chrome
 * `inert` while this is open. The overlay is `role="region"` (not a modal
 * dialog) — it's a persistent first-class view, so it doesn't trap focus or
 * announce as a modal. Escape closes it via the LIFO escape stack, which also
 * lets nested confirm/URL dialogs close first (#2828).
 *
 * Nested confirm dialogs (uninstall, update, HTTP install) and the URL-input
 * dialog render at `zIndex="nested"` so they layer above this view and the LIFO
 * escape backstop closes the inner surface first.
 */
export function PluginManagerView({ deepLinkIntent, onDeepLinkConsumed }: PluginManagerViewProps) {
  const isOpen = usePluginManagerStore((s) => s.isOpen);
  const close = usePluginManagerStore((s) => s.close);

  // Register the viewport claim so AppLayout can `inert` the app chrome while
  // the view is open, and wire Escape-to-close through the shared LIFO stack.
  useOverlayClaim("plugin-manager", isOpen);
  useEscapeStack(isOpen, close);

  // This view is `fixed inset-0` at z-modal, so it paints over the Toolbar and
  // its OS-window-control reservations. Mirror the Toolbar's traffic-light /
  // window-controls spacers in our own header so the title and close button
  // never sit under the macOS lights (top-left) or Windows controls (top-right).
  // Both collapse in fullscreen, where the OS chrome is gone.
  const [isFullscreen, setIsFullscreen] = useState(false);
  useEffect(() => {
    return window.electron.window.onFullscreenChange(setIsFullscreen);
  }, []);

  const pm = usePluginManager(isOpen, {
    intent: deepLinkIntent ?? null,
    onConsumed: onDeepLinkConsumed,
  });
  // Selection is pure UI state owned by the view — `usePluginManager` stays
  // data/IPC only. The detail pane derives from the selected id.
  const [selectedPluginId, setSelectedPluginId] = useState<string | null>(null);
  const selectedPlugin =
    selectedPluginId === null
      ? null
      : (pm.plugins.find((p) => p.manifest.name === selectedPluginId) ?? null);

  // Row elements keyed by plugin name, so a `daintree://plugin/open` (#9559) can
  // scroll its target into view.
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const [highlightedPluginId, setHighlightedPluginId] = useState<string | null>(null);

  // Free-text + operator filter (#9557). The input binds to the immediate
  // `query`; the expensive filter pass runs against the deferred value so typing
  // stays responsive (LESSON #3726 — useDeferredValue, not setTimeout debounce).
  const searchInputRef = useRef<HTMLInputElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const isSearchActive = useMemo(
    () => isQueryActive(parsePluginQuery(deferredQuery)),
    [deferredQuery]
  );
  const filteredPlugins = useMemo(
    () => (isSearchActive ? filterPlugins(pm.plugins, deferredQuery) : pm.plugins),
    [isSearchActive, pm.plugins, deferredQuery]
  );
  // Category buckets for the section headers and the catalog pane. Disabled
  // plugins stay in their category (dimmed in place) — see PluginRow.
  const groupedPlugins = useMemo(() => groupPluginsByCategory(pm.plugins), [pm.plugins]);

  // Lowercased whitespace-split tokens of the live query, for chip active
  // state. Derived from `query` (not the deferred value) so the chip highlight
  // flips in the same frame as the click.
  const queryTokens = useMemo(
    () =>
      query
        .split(/\s+/)
        .filter(Boolean)
        .map((t) => t.toLowerCase()),
    [query]
  );

  // Chips are toggles: clicking adds the operator token, clicking again
  // removes it (operators are case-insensitive, so match tokens that way too).
  // The active chip is highlighted via aria-pressed + a neutral surface lift —
  // multi-select state never takes the accent.
  const toggleFilterToken = (token: string) => {
    const lower = token.toLowerCase();
    setQuery((prev) => {
      const tokens = prev.split(/\s+/).filter(Boolean);
      if (tokens.some((t) => t.toLowerCase() === lower)) {
        return tokens.filter((t) => t.toLowerCase() !== lower).join(" ");
      }
      return prev.length === 0 ? token : `${prev.trim()} ${token}`;
    });
    searchInputRef.current?.focus();
  };

  // Reset the query when the view closes so a stale filter doesn't hide rows
  // on reopen. Search is a permanent fixture of the catalog (the former
  // 10-item visibility threshold from #9557 went with the marketplace
  // redesign), so there's no threshold edge to reset on anymore.
  useEffect(() => {
    if (!isOpen) setQuery("");
  }, [isOpen]);

  // Move focus into the view when it opens. Unlike the former modal dialog, a
  // role="region" view doesn't trap focus, so without this the keyboard focus
  // can stay on a background grid terminal — and `terminal.close` (Cmd+W) skips
  // the escape stack while a grid panel is focused, closing the terminal
  // instead of the view. Prefer the filter input when shown, else the close
  // button. Mirrors ThemeBrowser's open-focus behaviour.
  useEffect(() => {
    if (!isOpen) return;
    const target = searchInputRef.current ?? closeButtonRef.current;
    target?.focus();
  }, [isOpen]);

  // Re-validate the selection after every list refresh (reopen, uninstall,
  // cross-window provenance change). A single effect keyed on the list nulls a
  // selection whose plugin is gone — kept here rather than in a second reset
  // effect that could race the hook's `isOpen` reset (#4958).
  useEffect(() => {
    if (
      selectedPluginId !== null &&
      !pm.plugins.some((p) => p.manifest.name === selectedPluginId)
    ) {
      setSelectedPluginId(null);
    }
  }, [pm.plugins, selectedPluginId]);

  // When a filter is active, also null a selection whose plugin is no longer in
  // the filtered set — otherwise the detail pane keeps showing a plugin that the
  // current query hides (#9557). Separate from the full-list effect above so the
  // two have independent dependency arrays and can't race.
  useEffect(() => {
    if (
      isSearchActive &&
      selectedPluginId !== null &&
      !filteredPlugins.some((p) => p.manifest.name === selectedPluginId)
    ) {
      setSelectedPluginId(null);
    }
  }, [isSearchActive, filteredPlugins, selectedPluginId]);

  // When the hook resolves a deep-link `open` target to an installed plugin
  // (#9559), select it, scroll its row into view, and apply a transient neutral
  // highlight, then clear the focus request so it doesn't re-trigger on the next
  // render.
  const focusPluginId = pm.focusPluginId;
  const clearFocusPluginId = pm.clearFocusPluginId;
  useEffect(() => {
    if (!focusPluginId) return;
    if (!pm.plugins.some((p) => p.manifest.name === focusPluginId)) return;
    // Clear any active filter so the deep-link target row is actually rendered
    // and can be scrolled into view (#9557 + #9559).
    setQuery("");
    setSelectedPluginId(focusPluginId);
    const row = rowRefs.current.get(focusPluginId);
    if (!row) return; // Row not rendered yet — leave focusPluginId set so a
    // subsequent list/filter refresh retries the scroll.
    row.scrollIntoView({ block: "center", behavior: "smooth" });
    setHighlightedPluginId(focusPluginId);
    clearFocusPluginId();
  }, [focusPluginId, clearFocusPluginId, pm.plugins]);

  // Fade the deep-link highlight after a beat. Kept separate from the consume
  // effect above: clearing focusPluginId there flips that effect's own
  // dependency, so an inline timer would be torn down a render later before it
  // ever fired. Keying this on `highlightedPluginId` lets the timer live until
  // it actually clears the highlight (or the view unmounts).
  useEffect(() => {
    if (!highlightedPluginId) return;
    const timer = setTimeout(() => setHighlightedPluginId(null), DEEP_LINK_HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [highlightedPluginId]);

  const hasPlugins = pm.plugins.length > 0;
  // Any enabled/disabled toggle this session that hasn't taken effect yet leaves
  // its plugin flagged `pendingRestart`. Surface a single header bar while at
  // least one is outstanding — the changes only load or unload on relaunch.
  const restartRequired = pm.plugins.some((p) => p.pendingRestart === true);
  const [isRestartConfirmOpen, setIsRestartConfirmOpen] = useState(false);
  const [isRestarting, setIsRestarting] = useState(false);
  // Synchronous mutex: `isRestarting` lags a render, so a same-frame double
  // activation could fire two relaunch requests before the disabled state
  // commits. The ref flips immediately to serialize this destructive IPC.
  const restartingRef = useRef(false);

  // If the pending-restart condition clears while the confirm is open (e.g. a
  // cross-window provenance refresh, or the user toggling everything back),
  // close the orphaned dialog so it can't relaunch — and kill agent work — for
  // a restart that's no longer needed. Skip while a relaunch is already in
  // flight (the toggle stays pending until the app actually exits).
  useEffect(() => {
    if (!restartRequired && !isRestarting) setIsRestartConfirmOpen(false);
  }, [restartRequired, isRestarting]);

  const handleRestart = async () => {
    if (restartingRef.current || !restartRequired) return;
    restartingRef.current = true;
    setIsRestarting(true);
    try {
      await window.electron.app.resetAndRelaunch();
    } catch (err) {
      // A failed relaunch leaves the app running — re-enable the button so the
      // user can retry rather than stranding them on a dead control.
      logError("Failed to restart Daintree for plugin changes", err);
      restartingRef.current = false;
      setIsRestarting(false);
    }
  };

  if (!isOpen) return null;

  return createPortal(
    <div
      role="region"
      aria-label="Plugin manager"
      data-testid="plugin-manager-view"
      className="fixed inset-0 z-[var(--z-modal)] flex flex-col bg-daintree-bg motion-safe:animate-in motion-safe:fade-in motion-safe:duration-150"
    >
      <header className="flex items-center justify-between gap-3 px-6 h-12 shrink-0 border-b border-daintree-border app-drag-region">
        <div className="flex items-center gap-2 min-w-0">
          {isMac() && (
            <div
              aria-hidden="true"
              data-fullscreen={isFullscreen ? "true" : undefined}
              className={cn(
                "shrink-0 transition-[width] duration-200 data-[fullscreen=true]:duration-[120ms]",
                isFullscreen ? "w-0" : "w-16"
              )}
            />
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={close}
            aria-label="Back"
            className="app-no-drag shrink-0"
          >
            <ChevronLeft />
          </Button>
          <Package className="w-5 h-5 text-daintree-text/70 shrink-0" aria-hidden="true" />
          <h2 className="text-sm font-medium text-daintree-text truncate">Plugins</h2>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <Button
            ref={closeButtonRef}
            variant="ghost"
            size="icon-sm"
            onClick={close}
            aria-label="Close plugin manager"
            className="app-no-drag"
          >
            <X />
          </Button>
          {isWindows() && (
            <div
              aria-hidden="true"
              data-fullscreen={isFullscreen ? "true" : undefined}
              className={cn(
                "shrink-0 transition-[width] duration-200 data-[fullscreen=true]:duration-[120ms]",
                isFullscreen && "w-0"
              )}
              style={
                isFullscreen
                  ? undefined
                  : { width: "calc(100vw - env(titlebar-area-width, calc(100vw - 138px)))" }
              }
            />
          )}
        </div>
      </header>

      {restartRequired && (
        <InlineStatusBanner
          icon={AlertTriangle}
          title="Restart required to apply plugin changes"
          severity="warning"
          role="status"
          actions={[
            {
              id: "restart",
              label: isRestarting ? "Restarting…" : "Restart",
              variant: "primary",
              onClick: () => setIsRestartConfirmOpen(true),
              disabled: isRestarting,
            },
          ]}
        />
      )}

      <div
        className="relative flex flex-1 min-h-0 overflow-hidden"
        onDragEnter={pm.handleDragEnter}
        onDragOver={pm.handleDragOver}
        onDragLeave={pm.handleDragLeave}
        onDrop={pm.handleDrop}
      >
        {pm.isDragOverFiles && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-daintree-bg/80 border-2 border-dashed border-daintree-border pointer-events-none">
            <Download className="w-6 h-6 text-daintree-text/60" aria-hidden="true" />
            <p className="text-sm font-medium text-daintree-text">Drop a .dntr file to install</p>
          </div>
        )}

        {/* Master: installed-plugin list + install controls. */}
        <div className="w-80 shrink-0 border-r border-daintree-border flex flex-col overflow-hidden">
          <div className="p-4 border-b border-daintree-border shrink-0 space-y-3">
            <div>
              <h3 className="text-sm font-medium text-daintree-text">Installed plugins</h3>
              <p className="text-xs text-daintree-text/50 mt-1 select-text">
                Extend Daintree with panels, commands, and integrations. Turn one off to keep its
                settings without loading it.
              </p>
            </div>
            <div className="flex flex-col gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void pm.handleInstallFromFile()}
                loading={pm.isInstalling}
              >
                <FilePlus />
                Install from file
              </Button>
              <Button variant="outline" size="sm" onClick={() => pm.setShowUrlDialog(true)}>
                <Link2 />
                Install from URL
              </Button>
            </div>
            <div className="space-y-2">
              <input
                ref={searchInputRef}
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search plugins"
                aria-label="Search plugins"
                className="w-full px-3 py-2 text-sm rounded-[var(--radius-md)] bg-daintree-bg border border-daintree-border text-daintree-text placeholder:text-text-placeholder focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent"
              />
              <div className="flex flex-wrap gap-1">
                {PLUGIN_FILTER_CHIPS.map(({ token, label }) => {
                  const active = queryTokens.includes(token.toLowerCase());
                  return (
                    <button
                      key={token}
                      type="button"
                      aria-pressed={active}
                      onClick={() => toggleFilterToken(token)}
                      className={cn(
                        "px-1.5 py-0.5 rounded-sm text-[10px] font-medium border transition-colors",
                        active
                          ? "bg-overlay-strong border-daintree-border text-daintree-text"
                          : "bg-overlay-subtle border-daintree-border/50 text-daintree-text/60 hover:text-daintree-text/80 hover:border-daintree-border"
                      )}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>
            {pm.notice && (
              <div className="flex items-start gap-2 p-2 rounded-[var(--radius-md)] bg-overlay-subtle border border-daintree-border">
                <Info className="w-3.5 h-3.5 text-daintree-text/50 shrink-0 mt-0.5" />
                <p className="text-[11px] text-daintree-text/70">{pm.notice}</p>
              </div>
            )}
            {pm.error && (
              <div className="flex items-start gap-2 p-2 rounded-[var(--radius-md)] bg-status-danger/10 border border-status-danger/20">
                <AlertCircle className="w-3.5 h-3.5 text-status-danger shrink-0 mt-0.5" />
                <p className="text-[11px] text-status-danger">{pm.error}</p>
              </div>
            )}
          </div>

          {pm.loading ? (
            pm.showInlineLoading ? (
              <div className="p-2 space-y-1">
                <RowSkeleton />
                <RowSkeleton />
                <RowSkeleton />
              </div>
            ) : null
          ) : !hasPlugins && !pm.error ? (
            // banner above owns that case so we don't invite a redundant install.
            <EmptyState
              variant="zero-data"
              scale="canvas"
              icon={<Package />}
              title="No plugins installed"
              description="Install one from a file or URL to add panels, commands, and integrations."
            />
          ) : !hasPlugins ? null : isSearchActive && filteredPlugins.length === 0 ? (
            // Filtered to nothing — offer a one-tap escape back to the full list.
            <div className="flex-1 min-h-0 flex items-center justify-center">
              <EmptyState
                variant="filtered-empty"
                scale="sidebar"
                title="No matching plugins"
                action={
                  <button
                    type="button"
                    onClick={() => setQuery("")}
                    className="text-xs text-daintree-text/60 hover:text-daintree-text underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent rounded-sm"
                  >
                    Clear search
                  </button>
                }
              />
            </div>
          ) : (
            <ScrollShadow
              className="flex-1 min-h-0"
              scrollClassName="p-2 space-y-4"
              role="listbox"
              aria-label="Installed plugins"
            >
              {isSearchActive
                ? // Flat filtered list — grouping is meaningless across filters
                  // like @installed, and a flat list keeps the listbox free of
                  // section labels.
                  filteredPlugins.map((plugin) => (
                    <PluginRow
                      key={plugin.manifest.name}
                      plugin={plugin}
                      selected={plugin.manifest.name === selectedPluginId}
                      toggling={pm.pending.has(plugin.manifest.name)}
                      onSelect={() =>
                        setSelectedPluginId((prev) =>
                          prev === plugin.manifest.name ? null : plugin.manifest.name
                        )
                      }
                      onToggle={() => void pm.handleToggle(plugin)}
                      highlighted={highlightedPluginId === plugin.manifest.name}
                      innerRef={(el) => {
                        if (el) rowRefs.current.set(plugin.manifest.name, el);
                        else rowRefs.current.delete(plugin.manifest.name);
                      }}
                    />
                  ))
                : PLUGIN_CATEGORIES.map(({ id, label }) => {
                    const groupPlugins = groupedPlugins.get(id);
                    if (!groupPlugins || groupPlugins.length === 0) return null;
                    // role="presentation" makes this wrapper transparent to the
                    // accessibility tree, so its option children re-parent to the
                    // listbox. The header is a disabled option, not a role="group"
                    // label (LESSON #9006 — group labels drop under Chromium 146 +
                    // VoiceOver); arrow-key nav still skips it.
                    return (
                      <div key={id} role="presentation" className="space-y-1">
                        <div
                          className={SECTION_HEADER_CLASS}
                          role="option"
                          aria-disabled="true"
                          aria-selected="false"
                          aria-label={label}
                        >
                          {label}
                          <span className="ml-1.5 normal-case tracking-normal text-daintree-text/30">
                            {groupPlugins.length}
                          </span>
                        </div>
                        {groupPlugins.map((plugin) => (
                          <PluginRow
                            key={plugin.manifest.name}
                            plugin={plugin}
                            selected={plugin.manifest.name === selectedPluginId}
                            toggling={pm.pending.has(plugin.manifest.name)}
                            onSelect={() =>
                              setSelectedPluginId((prev) =>
                                prev === plugin.manifest.name ? null : plugin.manifest.name
                              )
                            }
                            onToggle={() => void pm.handleToggle(plugin)}
                            highlighted={highlightedPluginId === plugin.manifest.name}
                            innerRef={(el) => {
                              if (el) rowRefs.current.set(plugin.manifest.name, el);
                              else rowRefs.current.delete(plugin.manifest.name);
                            }}
                          />
                        ))}
                      </div>
                    );
                  })}
            </ScrollShadow>
          )}

          {/* Reserved footer for the browse/discovery catalog (#9305). The
              network-backed catalog ships separately; the slot keeps its place
              in the master column so the layout doesn't shift when it lands. */}
          <div className="px-4 py-3 border-t border-daintree-border shrink-0">
            <p className="text-[10px] font-medium uppercase tracking-wider text-daintree-text/40 select-none">
              Browse
            </p>
            <p className="text-[11px] text-daintree-text/40 mt-1">
              Online plugin catalog coming soon.
            </p>
          </div>
        </div>

        {/* Detail: selected plugin's metadata, actions, and settings. The key
            is on the scroll container (not the pane) so switching plugins
            remounts the whole subtree — resetting scrollTop to the top,
            re-initializing PluginSettingsForm drafts from the new plugin's
            stored values, and resetting the detail subtab to Overview. */}
        <ScrollShadow
          key={selectedPlugin?.manifest.name ?? "catalog"}
          className="flex-1 min-h-0"
          // The readable-width caps are left-pinned, which is right for the
          // detail content and the catalog grid but would push the centered
          // no-plugins placeholder off-center in the wide pane — so that case
          // drops the cap. The catalog gets the wider cap; cards auto-fill it.
          scrollClassName={cn("p-6", selectedPlugin ? "max-w-3xl" : hasPlugins && "max-w-4xl")}
        >
          {selectedPlugin ? (
            <PluginDetailPane
              plugin={selectedPlugin}
              checkingUpdate={pm.checkingUpdate.has(selectedPlugin.manifest.name)}
              upToDate={pm.upToDateId === selectedPlugin.manifest.name}
              onUninstall={() => pm.armUninstall(selectedPlugin)}
              onCheckForUpdate={() => void pm.handleCheckForUpdate(selectedPlugin)}
            />
          ) : hasPlugins ? (
            // Catalog home — the marketplace face of the manager. Clicking a
            // card selects the plugin (same as its row); clicking the selected
            // row again returns here. An active search narrows the storefront
            // to the same filtered set as the master list.
            <PluginCatalog
              plugins={isSearchActive ? filteredPlugins : pm.plugins}
              onSelect={setSelectedPluginId}
            />
          ) : (
            // No plugins at all — a roomy centered prompt rather than an empty
            // catalog shell; the master column owns the install CTAs.
            <div className="h-full flex flex-col items-center justify-center gap-3 px-6 text-center">
              <Package className="w-8 h-8 text-daintree-text/30" aria-hidden="true" />
              <p className="text-base font-medium text-daintree-text/80">No plugin selected</p>
              <p className="text-sm text-daintree-text/50 max-w-sm">
                Install a plugin to view its details and settings here.
              </p>
            </div>
          )}
        </ScrollShadow>
      </div>

      <ConfirmDialog
        isOpen={pm.pendingUninstall !== null}
        onClose={pm.isUninstalling ? undefined : pm.closeUninstall}
        title={pm.pendingUninstall ? `Uninstall '${pluginLabel(pm.pendingUninstall)}'?` : ""}
        description="Removes the plugin and deletes its files, unloading its panels, commands, and integrations. Per-project settings under .daintree/ are always kept; this plugin's saved settings are kept too unless you check the box below."
        confirmLabel="Uninstall plugin"
        cancelLabel="Keep plugin"
        onConfirm={() => void pm.confirmUninstall()}
        isConfirmLoading={pm.isUninstalling}
        variant="destructive"
        zIndex="nested"
      >
        <label className="flex items-center gap-2 text-xs text-daintree-text/70 select-none cursor-pointer">
          <input
            type="checkbox"
            checked={pm.deleteSettings}
            onChange={(e) => pm.setDeleteSettings(e.target.checked)}
            disabled={pm.isUninstalling}
            className="size-3.5 rounded-sm border border-daintree-border bg-daintree-bg accent-daintree-text/70"
          />
          Also delete this plugin's saved settings
        </label>
      </ConfirmDialog>

      <ConfirmDialog
        isOpen={pm.pendingUpdate !== null}
        onClose={pm.isReinstalling ? undefined : () => pm.setPendingUpdate(null)}
        title={pm.pendingUpdate ? `Update '${pluginLabel(pm.pendingUpdate.plugin)}'?` : ""}
        description="Downloads the latest archive and reinstalls over the current version. Your settings are kept."
        confirmLabel="Reinstall plugin"
        cancelLabel="Cancel"
        onConfirm={() => void pm.confirmReinstall()}
        isConfirmLoading={pm.isReinstalling}
        variant="default"
        zIndex="nested"
      >
        {pm.pendingUpdate && (
          <div className="mt-3 space-y-1.5 text-xs text-daintree-text/70">
            <div>
              <span className="text-daintree-text/50">New version</span>{" "}
              <span className="font-medium text-daintree-text">
                v{pm.pendingUpdate.result.version}
              </span>
              {pm.pendingUpdate.result.displayName &&
                pm.pendingUpdate.result.displayName !== pluginLabel(pm.pendingUpdate.plugin) && (
                  <span className="text-daintree-text/50">
                    {" "}
                    · now named {pm.pendingUpdate.result.displayName}
                  </span>
                )}
            </div>
            {pm.pendingUpdate.result.capabilities.length > 0 && (
              <div>
                <span className="text-daintree-text/50">Capabilities</span>{" "}
                <span className="text-daintree-text">
                  {pm.pendingUpdate.result.capabilities.join(", ")}
                </span>
              </div>
            )}
          </div>
        )}
      </ConfirmDialog>

      <ConfirmDialog
        isOpen={pm.pendingHttpUrl !== null}
        onClose={pm.isInstalling ? undefined : pm.cancelHttpInstall}
        title="Install over HTTP?"
        description="This URL doesn't use HTTPS, so the download isn't encrypted or authenticated in transit. Only continue if you trust the source."
        confirmLabel="Install over HTTP"
        cancelLabel="Cancel"
        onConfirm={() => void pm.confirmHttpInstall()}
        isConfirmLoading={pm.isInstalling}
        variant="destructive"
        zIndex="nested"
      />

      <AppDialog
        isOpen={pm.showUrlDialog}
        onClose={() => {
          if (pm.isInstalling) return;
          pm.closeUrlDialog();
        }}
        size="sm"
        zIndex="nested"
        initialFocus="first"
      >
        <AppDialog.Header>
          <AppDialog.Title>Install from URL</AppDialog.Title>
          <AppDialog.CloseButton />
        </AppDialog.Header>
        <AppDialog.Body className="space-y-3">
          <AppDialog.Description>
            Enter the URL of a Daintree plugin archive (.dntr). It's downloaded, validated, and
            installed. Plugins run with full Node.js privileges — there's no sandbox, no signature
            check, and no capability prompt before install. Only install from sources you trust.
          </AppDialog.Description>
          <input
            type="url"
            value={pm.urlInput}
            onChange={(e) => pm.setUrlInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && pm.urlInput.trim()) void pm.handleInstallFromUrl();
            }}
            placeholder="https://example.com/plugin.dntr"
            className="w-full px-3 py-2 text-sm rounded-[var(--radius-md)] bg-daintree-bg border border-daintree-border text-daintree-text placeholder:text-text-placeholder focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent"
            aria-label="Plugin URL"
          />
        </AppDialog.Body>
        <AppDialog.Footer
          secondaryAction={{
            label: "Cancel",
            onClick: pm.closeUrlDialog,
            disabled: pm.isInstalling,
          }}
          primaryAction={{
            label: "Install",
            onClick: () => void pm.handleInstallFromUrl(),
            loading: pm.isInstalling,
            disabled: pm.urlInput.trim().length === 0,
          }}
        />
      </AppDialog>

      <ConfirmDialog
        isOpen={isRestartConfirmOpen}
        onClose={isRestarting ? undefined : () => setIsRestartConfirmOpen(false)}
        title="Restart Daintree now?"
        description="All running terminals and agent sessions will be closed, and any in-flight agent work and scrollback will be lost."
        confirmLabel="Restart Daintree"
        cancelLabel="Not now"
        onConfirm={() => void handleRestart()}
        isConfirmLoading={isRestarting}
        variant="destructive"
        zIndex="nested"
      />
    </div>,
    document.body
  );
}
