import {
  Package,
  FilePlus,
  Link2,
  Info,
  Download,
  AlertCircle,
  AlertTriangle,
  ChevronDown,
  ChevronLeft,
  RefreshCw,
  X,
} from "lucide-react";
import { useState, useEffect, useRef, useMemo, useDeferredValue } from "react";
import { createPortal } from "react-dom";
import { SettingsSwitch } from "@/components/Settings/SettingsSwitch";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { AppDialog } from "@/components/ui/AppDialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { ScrollShadow } from "@/components/ui/ScrollShadow";
import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
import { CapabilityRow } from "@/components/Plugin/capabilityMeta";
import { usePluginManagerStore } from "@/store/pluginManagerStore";
import { useProjectPluginStore } from "@/store/projectPluginStore";
import { useOverlayClaim } from "@/hooks";
import { useEscapeStack } from "@/hooks/useEscapeStack";
import { useShouldSkipMotion } from "@/hooks/useShouldSkipMotion";
import { logError } from "@/utils/logger";
import { cn } from "@/lib/utils";
import { PALETTE_ROW_CLASS } from "@/components/ui/paletteRowStyles";
import { isMac, isWindows } from "@/lib/platform";
import { WINDOWS_CAPTION_WIDTH_PX } from "@shared/config/windowChrome";
import { usePluginManager } from "./usePluginManager";
import { PluginDetailPane, SOURCE_BADGE_LABELS, pluginLabel } from "./PluginDetailPane";
import { PluginInstallProgressBanner } from "./PluginInstallProgressBanner";
import { PluginCatalog } from "./PluginCatalog";
import { PluginIconTile } from "./pluginIcons";
import { pluginSignalFor } from "./pluginStatus";
import { ProjectPluginSection, ProjectPluginDetailPane } from "./ProjectPluginSection";
import { groupPluginsByCategory } from "./pluginGrouping";
import { filterPlugins, isQueryActive, parsePluginQuery } from "@/lib/pluginSearch";
import { PLUGIN_CATEGORIES } from "@shared/config/pluginCategoryRegistry";
import type { LoadedPluginInfo, PluginDeepLinkIntent } from "@shared/types/plugin";

// Provenance badge — where the archive came from. Deliberately the quietest
// thing in the row: it is trivia next to whether the plugin is actually running.
const ROW_BADGE_CLASS =
  "inline-flex items-center px-1.5 py-0.5 rounded-sm text-3xs font-medium bg-overlay-subtle border border-border-default/50 text-text-secondary uppercase tracking-wide";

const SECTION_HEADER_CLASS =
  "px-3 text-3xs font-medium uppercase tracking-wider text-text-secondary select-none";

// How long the result count waits for typing to pause before it is announced.
// Announcing every intermediate count queues a sentence per keystroke.
const SEARCH_ANNOUNCE_DELAY_MS = 500;

/**
 * Whether a project plugin is broken in the sense the health summary means.
 *
 * Deliberately one predicate shared by the count and the filter behind it: when
 * they were written separately the count keyed on `invalid` alone, so a plugin
 * that loaded and then threw was both missing from the total and excluded by
 * the filter the total links to.
 */
function isProjectPluginBroken(plugin: { state: string; loadError?: unknown }): boolean {
  return plugin.state === "invalid" || plugin.loadError != null;
}

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
  innerRef?: (el: HTMLLIElement | null) => void;
  /** Transient neutral highlight when a deep-link `open` targets this row. */
  highlighted?: boolean;
}

/**
 * One installed-plugin row in the master list (#9555): icon tile, name, one
 * line of detail, and the enable toggle. Selecting it populates the detail pane
 * on the right, so the row stays scannable and never shifts layout.
 *
 * Exactly two lines in every state. The name owns the first line outright — the
 * version used to share it, and on a long name plus a prerelease semver the two
 * elided each other down to "Enterprise C…" and "v2.4.1-alpha…", so neither
 * identified anything. The version lives in the detail header. The second line
 * is the plugin's one operational signal when it has one (failed, blocked,
 * restart, update) and its blurb otherwise: a failure is the most important
 * thing the row can say, so it takes the line that was spent on marketing copy,
 * and it keeps the row the same height as its healthy neighbours. Provenance
 * trails that line as quiet pills, right-aligned so they read as a column.
 *
 * A disabled plugin stays in its category section, dimmed in place with its
 * switch off — the dominant pattern (VS Code, JetBrains, browsers) and the one
 * that preserves spatial memory. Provenance only earns a badge when it differs
 * from the catalog's default (non-builtin sources: file / URL / catalog).
 *
 * The row is an `<li>` in a plain list, NOT an option in a composite listbox.
 * The selection target is a `<button aria-current>` covering the info area and
 * the enable toggle is a sibling control, which a `listbox` may not own: its
 * required owned elements are `option`/`group`, so the switch was an ARIA
 * content-model violation that screen readers prune or skip.
 *
 * Selection is `PALETTE_ROW_CLASS` — the app's single definition of "this is the
 * row Enter will act on", which already owns the neutral leading rail, the
 * reduce-motion handling, and the forced-colors outline. `row-select-target`
 * exempts the inner button from the high-contrast blanket button border, which
 * otherwise framed the text half of every row and left its switch outside.
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
  const blocklisted = plugin.blocklisted === true;
  // The switch reflects the user's INTENT, which is the only thing it controls.
  // Whether the plugin actually runs is a separate fact and gets its own line —
  // conflating them is what made a failed plugin wear a confident "on" switch.
  const enabled = plugin.disabled !== true && !blocklisted;
  const healthy = !blocklisted && !plugin.loadError;
  const sourceLabel = SOURCE_BADGE_LABELS[plugin.source] ?? plugin.source;
  // Only the two forge built-ins actually set a tagline, so a row keyed solely
  // on it renders a bare name for almost every third-party plugin. `PluginCard`
  // already falls back to the description; the list agrees with it.
  const blurb = plugin.manifest.tagline ?? plugin.manifest.description;
  const signal = pluginSignalFor(plugin);

  return (
    <li
      ref={innerRef}
      data-selected={selected ? "true" : undefined}
      className={cn(
        PALETTE_ROW_CLASS,
        "flex items-center gap-2 rounded-[var(--radius-md)] text-text-primary",
        !selected && highlighted && "border-daintree-text/40 bg-overlay-subtle",
        !selected && !highlighted && "hover:bg-overlay-subtle"
      )}
    >
      <button
        type="button"
        aria-current={selected ? "true" : undefined}
        onClick={onSelect}
        title={`${label} v${plugin.manifest.version}`}
        className="row-select-target flex items-center gap-2.5 min-w-0 flex-1 py-2 pl-3 pr-1 text-left rounded-[var(--radius-md)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary forced-colors:border-none"
      >
        <PluginIconTile manifest={plugin.manifest} size="sm" dimmed={!enabled || !healthy} />
        <span className="min-w-0 flex-1">
          <span
            className={cn("block text-sm font-medium truncate", !enabled && "text-text-secondary")}
          >
            {label}
          </span>
          <span
            data-testid="plugin-row-badges"
            className="mt-0.5 flex items-center gap-1.5 min-w-0 h-[1.125rem]"
          >
            {signal ? (
              <span
                className={cn(
                  "inline-flex items-center gap-1 min-w-0 flex-1 text-2xs font-medium",
                  signal.tone
                )}
              >
                <signal.icon className="w-3 h-3 shrink-0" aria-hidden="true" />
                <span className="truncate">{signal.label}</span>
              </span>
            ) : (
              <span className="min-w-0 flex-1 truncate text-2xs text-text-secondary">{blurb}</span>
            )}
            {plugin.devMode && <span className={cn(ROW_BADGE_CLASS, "shrink-0")}>Dev</span>}
            {!plugin.isBuiltin && (
              <span className={cn(ROW_BADGE_CLASS, "shrink-0")}>{sourceLabel}</span>
            )}
          </span>
        </span>
      </button>

      <span className="shrink-0 pr-2.5">
        <SettingsSwitch
          checked={enabled}
          onCheckedChange={onToggle}
          disabled={toggling || blocklisted}
          aria-label={`Enable ${label}`}
        />
      </span>
    </li>
  );
}

function RowSkeleton() {
  return (
    <div className="w-full flex items-center gap-2.5 py-2 px-3 rounded-[var(--radius-md)]">
      <div className="flex items-center gap-2.5 w-full animate-pulse-delayed">
        <div className="w-8 h-8 rounded-[var(--radius-md)] bg-overlay-strong" />
        <div className="flex-1 space-y-2">
          <div className="h-3 w-24 rounded-sm bg-overlay-strong" />
          <div className="h-2 w-36 rounded-sm bg-overlay-strong" />
        </div>
        <div className="w-9 h-5 rounded-full bg-overlay-strong" />
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
  // The global keybinding layer takes Escape at window capture and pops the
  // escape stack before Radix's menu ever sees the key, so an open Install
  // menu has to be on the stack itself — otherwise Escape closes the whole
  // view instead of the menu. Registered after the view's own entry, so LIFO
  // pops the menu first.
  const [isInstallMenuOpen, setIsInstallMenuOpen] = useState(false);
  useEscapeStack(isOpen && isInstallMenuOpen, () => setIsInstallMenuOpen(false));
  const skipMotion = useShouldSkipMotion();

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
  // Install-from-URL and uninstall both keep their dialog open on a correctable
  // failure, and both wrote the reason to the one error slot in the master
  // column — behind the dialog's own scrim. Each now renders the message
  // itself, and this stops the sidebar showing a second, hidden copy.
  const errorOwnedByDialog = pm.showUrlDialog || pm.pendingUninstall !== null;

  // Selection is pure UI state owned by the view — `usePluginManager` stays
  // data/IPC only. The detail pane derives from the selected id.
  const [selectedPluginId, setSelectedPluginId] = useState<string | null>(null);
  const selectedPlugin =
    selectedPluginId === null
      ? null
      : (pm.plugins.find((p) => p.manifest.name === selectedPluginId) ?? null);

  // Project plugins keep their own selection slot. They arrive from a different
  // source (`plugin:project-plugins-changed`, not `plugin:list`) and their
  // manifest ids may legitimately collide with an installed plugin's, so one
  // shared id would make the detail pane ambiguous exactly where the collision
  // most needs explaining. Selecting on either side clears the other.
  const [selectedProjectPluginId, setSelectedProjectPluginId] = useState<string | null>(null);
  const projectPlugins = useProjectPluginStore((s) => s.plugins);
  const selectedProjectPlugin =
    selectedProjectPluginId === null
      ? null
      : (projectPlugins.find((p) => p.id === selectedProjectPluginId) ?? null);

  // Row elements keyed by plugin name, so a `daintree://plugin/open` (#9559) can
  // scroll its target into view.
  const rowRefs = useRef<Map<string, HTMLLIElement>>(new Map());
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
  // The health summary hides itself the moment a query is typed. It keys off
  // the LIVE query, not the deferred one the results use: under deferral an
  // intermediate render can show the typed text with the summary still up.
  const isLiveQueryActive = useMemo(() => isQueryActive(parsePluginQuery(query)), [query]);
  const filteredPlugins = useMemo(
    () => (isSearchActive ? filterPlugins(pm.plugins, deferredQuery) : pm.plugins),
    [isSearchActive, pm.plugins, deferredQuery]
  );
  // Category buckets for the section headers and the catalog pane. Disabled
  // plugins stay in their category (dimmed in place) — see PluginRow.
  const groupedPlugins = useMemo(() => groupPluginsByCategory(pm.plugins), [pm.plugins]);

  // Project rows answer to free text only. The provenance operators describe
  // installed-plugin sources (`@builtin` / `@installed`), and a project plugin is
  // neither — matching one against them would be a wrong answer, not a narrow one.
  const filteredProjectPlugins = useMemo(() => {
    const parsed = parsePluginQuery(deferredQuery);
    // Project plugins answer to free text only — the provenance and state
    // operators describe an installed plugin's record, which they don't have.
    // `@problem` is the exception: the health summary counts an unreadable
    // project plugin as broken, so the filter behind that count has to be able
    // to show it, or the summary would promise rows it then hides.
    let pool = projectPlugins;
    if (parsed.operators.length > 0) {
      const onlyProblem = parsed.operators.every((op) => op.key === "problem");
      if (!onlyProblem) return [];
      pool = projectPlugins.filter(isProjectPluginBroken);
    }
    // Free text narrows whatever the operators left, exactly as it does for
    // installed plugins — `@problem notes` used to return every broken project
    // plugin because the operator branch returned before reading the text.
    const text = parsed.freeText.trim().toLowerCase();
    if (text.length === 0) return pool;
    return pool.filter(
      (p) =>
        p.displayName.toLowerCase().includes(text) ||
        p.id.toLowerCase().includes(text) ||
        (p.description ?? "").toLowerCase().includes(text)
    );
  }, [projectPlugins, deferredQuery]);

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
  // multi-select state never takes the accent. Focus stays on the chip: moving
  // it to the search box made a keyboard user walk back through every chip to
  // combine a second filter.
  const toggleFilterToken = (token: string) => {
    const lower = token.toLowerCase();
    setQuery((prev) => {
      const tokens = prev.split(/\s+/).filter(Boolean);
      if (tokens.some((t) => t.toLowerCase() === lower)) {
        return tokens.filter((t) => t.toLowerCase() !== lower).join(" ");
      }
      return prev.length === 0 ? token : `${prev.trim()} ${token}`;
    });
  };

  const clearSearch = () => {
    setQuery("");
    searchInputRef.current?.focus();
  };

  // The result count, as a status message (WCAG 4.1.3): a filter that rewrites
  // both panes was otherwise silent to a screen reader, whose user had to leave
  // the input to learn whether anything matched. Coalesced until typing pauses
  // so it speaks once per query rather than once per keystroke.
  const resultCount = filteredPlugins.length + filteredProjectPlugins.length;
  const [searchAnnouncement, setSearchAnnouncement] = useState("");
  useEffect(() => {
    if (!isSearchActive) {
      setSearchAnnouncement("");
      return;
    }
    const message =
      resultCount === 0
        ? "No matching plugins"
        : resultCount === 1
          ? "1 matching plugin"
          : `${resultCount} matching plugins`;
    const timer = setTimeout(() => setSearchAnnouncement(message), SEARCH_ANNOUNCE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [isSearchActive, resultCount, deferredQuery]);

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

  // The same reconciliation for the project inventory, which had none: a
  // project plugin could be selected and then filtered out of the list while
  // its detail pane carried on rendering — the "search hides the thing you are
  // inspecting" trap, and `filteredProjectPlugins` returns [] for ANY operator
  // query, so it took only a chip click to get there.
  useEffect(() => {
    if (
      selectedProjectPluginId !== null &&
      !filteredProjectPlugins.some((p) => p.id === selectedProjectPluginId)
    ) {
      setSelectedProjectPluginId(null);
    }
  }, [filteredProjectPlugins, selectedProjectPluginId]);

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
    // Honour reduced motion: a deep link can land anywhere in the list, so the
    // smooth scroll is an arbitrarily long animation the user never asked for.
    row.scrollIntoView({ block: "center", behavior: skipMotion ? "auto" : "smooth" });
    setHighlightedPluginId(focusPluginId);
    clearFocusPluginId();
  }, [focusPluginId, clearFocusPluginId, pm.plugins, skipMotion]);

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

  // Hand focus back when the control holding it disappears. Under a filter,
  // flipping a row's switch can remove that row (enable one under "Disabled"),
  // and the selection reconciliation above then drops its detail pane too — in
  // both cases the focused element leaves the DOM and the keyboard lands on
  // document.body, outside the view. The search field is the one control that
  // is always present and owns what just happened.
  const lastFocusedRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const last = lastFocusedRef.current;
    if (!last || last.isConnected) return;
    lastFocusedRef.current = null;
    if (document.activeElement === null || document.activeElement === document.body) {
      searchInputRef.current?.focus();
    }
  });

  const hasPlugins = pm.plugins.length > 0;
  // The list, the empty state and the detail placeholder all key off "is there
  // anything to show" — a project that ships plugins with none installed globally
  // must not fall through to "No plugins installed".
  const hasAnyPlugins = hasPlugins || projectPlugins.length > 0;
  // Any enabled/disabled toggle this session that hasn't taken effect yet leaves
  // its plugin flagged `pendingRestart`. Surface a single header bar while at
  // least one is outstanding — the changes only load or unload on relaunch.
  const restartRequired = pm.plugins.some((p) => p.pendingRestart === true);

  // "Is anything broken?" is the first question this screen exists to answer,
  // and it was the one it answered last: a plugin that failed to load looked
  // healthy until you scrolled to its row. Counted across BOTH inventories,
  // because a project plugin that can't be read is just as broken and had no
  // signal of its own at all. Restart-pending is deliberately excluded — it
  // already owns the header banner below and is not a fault.
  const brokenInstalled = pm.plugins.filter(
    (p) => p.loadError != null || p.blocklisted === true
  ).length;
  const brokenProject = projectPlugins.filter(isProjectPluginBroken).length;
  const brokenCount = brokenInstalled + brokenProject;
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
      onFocus={(e) => {
        lastFocusedRef.current = e.target instanceof HTMLElement ? e.target : null;
      }}
      className="fixed inset-0 z-[var(--z-modal)] flex flex-col bg-surface-canvas motion-safe:animate-in motion-safe:fade-in motion-safe:duration-150"
    >
      <header className="flex items-center justify-between gap-3 px-6 h-12 shrink-0 border-b border-border-default app-drag-region">
        <div className="flex items-center gap-2 min-w-0">
          {isMac() && (
            <div
              aria-hidden="true"
              data-fullscreen={isFullscreen ? "true" : undefined}
              className={cn(
                "shrink-0 transition-[width] duration-200 data-[fullscreen=true]:duration-120",
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
          <Package className="w-5 h-5 text-text-secondary shrink-0" aria-hidden="true" />
          <h2 className="text-sm font-medium text-text-primary truncate">Plugins</h2>
        </div>
        {/* Install and update are view-level actions, so they live on the
            view's own title bar rather than stacked full-width above the list.
            Three full-width buttons there cost a third of the column's height
            and pushed the installed list — the thing most visits come for —
            below the fold. */}
        <div className="flex items-center gap-2 shrink-0">
          {pm.hasUpdatablePlugins && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void pm.checkAllForUpdates()}
              loading={pm.isCheckingAllUpdates}
              className="app-no-drag"
            >
              <RefreshCw />
              Update all
            </Button>
          )}
          <DropdownMenu open={isInstallMenuOpen} onOpenChange={setIsInstallMenuOpen}>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" loading={pm.isInstalling} className="app-no-drag">
                <Download />
                Install plugin
                <ChevronDown className="text-text-secondary" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[180px]">
              <DropdownMenuItem onSelect={() => void pm.handleInstallFromFile()}>
                <FilePlus className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
                Install from file
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={pm.openUrlDialog}>
                <Link2 className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
                Install from URL
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
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
                "shrink-0 transition-[width] duration-200 data-[fullscreen=true]:duration-120",
                isFullscreen && "w-0"
              )}
              style={isFullscreen ? undefined : { width: `${WINDOWS_CAPTION_WIDTH_PX}px` }}
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

      {/* Top-level, not inside the install controls: a drop-install and a URL
          install start from different surfaces but report to the same place. */}
      <PluginInstallProgressBanner
        isInstalling={pm.hasActiveInstallJob}
        progress={pm.installProgress}
        cancelRequested={pm.cancelRequested}
        onCancel={pm.cancelActiveInstall}
      />

      <div
        className="relative flex flex-1 min-h-0 overflow-hidden"
        onDragEnter={pm.handleDragEnter}
        onDragOver={pm.handleDragOver}
        onDragLeave={pm.handleDragLeave}
        onDrop={pm.handleDrop}
      >
        {pm.isDragOverFiles && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-daintree-bg/80 border-2 border-dashed border-border-default pointer-events-none">
            <Download className="w-6 h-6 text-text-secondary" aria-hidden="true" />
            <p className="text-sm font-medium text-text-primary">Drop a .dntr file to install</p>
          </div>
        )}

        {/* Master: find and filter, then the installed list. */}
        <div className="w-80 shrink-0 border-r border-border-default flex flex-col overflow-hidden">
          <div className="p-3 border-b border-border-default shrink-0 space-y-2">
            <div className="relative">
              <input
                ref={searchInputRef}
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search plugins"
                aria-label="Search plugins"
                className="w-full pl-3 pr-8 py-1.5 text-sm rounded-[var(--radius-md)] bg-surface-canvas border border-border-interactive text-text-primary placeholder:text-text-secondary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary [&::-webkit-search-cancel-button]:appearance-none"
              />
              {/* The native cancel glyph is a UA bitmap — heavier and brighter
                  than every icon around it, and untouched by the theme. */}
              {query.length > 0 && (
                <button
                  type="button"
                  onClick={clearSearch}
                  aria-label="Clear search"
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 rounded-sm text-text-secondary hover:text-text-primary transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary"
                >
                  <X className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
              )}
            </div>
            <div role="group" aria-label="Filter plugins" className="flex flex-wrap gap-1">
              {PLUGIN_FILTER_CHIPS.map(({ token, label }) => {
                const active = queryTokens.includes(token.toLowerCase());
                return (
                  <button
                    key={token}
                    type="button"
                    aria-pressed={active}
                    onClick={() => toggleFilterToken(token)}
                    className={cn(
                      // The ring's colour is component-owned: with no
                      // `focus-visible` outline declared, the chips fell back to
                      // Chromium's default blue.
                      "px-1.5 py-0.5 rounded-sm text-3xs font-medium border transition-colors",
                      "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary",
                      // Pressed is the segmented control's selected treatment: a
                      // text-secondary border clears 3:1 against the fill, where
                      // a fill step alone read as barely different from rest.
                      // Forced colours repaint every border alike, so the
                      // pressed one takes the system highlight there.
                      active
                        ? "bg-overlay-medium border-text-secondary text-text-primary forced-colors:border-[Highlight]"
                        : "bg-overlay-subtle border-border-default/50 text-text-secondary hover:text-text-primary hover:border-border-default"
                    )}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
            <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
              {searchAnnouncement}
            </p>
            {/* The health summary. Deliberately a filter, not a re-sort: the
                list keeps its category order and its spatial memory, and this
                is the one control that narrows to the trouble. It disappears
                entirely when nothing is wrong, so a healthy install pays no
                permanent chrome for it. */}
            {brokenCount > 0 && !isLiveQueryActive && (
              <button
                type="button"
                onClick={() => {
                  setQuery("@problem");
                  // This button unmounts the moment the filter applies, so it
                  // hands focus to the control that now owns the query rather
                  // than stranding the keyboard on document.body.
                  searchInputRef.current?.focus();
                }}
                className="w-full flex items-center gap-2 p-2 rounded-[var(--radius-md)] bg-status-danger/10 border border-status-danger/20 text-left transition-colors hover:bg-status-danger/15 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary"
              >
                <AlertCircle
                  className="w-3.5 h-3.5 text-status-danger shrink-0"
                  aria-hidden="true"
                />
                <span className="text-2xs text-status-danger min-w-0 flex-1">
                  {brokenCount === 1
                    ? "1 plugin needs attention"
                    : `${brokenCount} plugins need attention`}
                </span>
                <span className="text-2xs text-status-danger underline underline-offset-2 shrink-0">
                  Show
                </span>
              </button>
            )}
            {pm.notice && (
              <div className="flex items-start gap-2 p-2 rounded-[var(--radius-md)] bg-overlay-subtle border border-border-default">
                <Info className="w-3.5 h-3.5 text-text-secondary shrink-0 mt-0.5" />
                <p className="text-2xs text-text-secondary">{pm.notice}</p>
              </div>
            )}
            {/* Suppressed while a dialog is showing the same error inside
                itself — otherwise the message renders twice, once of them
                underneath the scrim. */}
            {pm.error && !errorOwnedByDialog && (
              <div className="flex items-start gap-2 p-2 rounded-[var(--radius-md)] bg-status-danger/10 border border-status-danger/20">
                <AlertCircle className="w-3.5 h-3.5 text-status-danger shrink-0 mt-0.5" />
                <p className="text-2xs text-status-danger">{pm.error}</p>
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
          ) : !hasAnyPlugins && !pm.error ? (
            // banner above owns that case so we don't invite a redundant install.
            <EmptyState
              variant="zero-data"
              scale="canvas"
              icon={<Package />}
              title="No plugins installed"
              description="Install one from a file or URL to add panels, commands, and integrations."
            />
          ) : !hasAnyPlugins ? null : isSearchActive &&
            filteredPlugins.length === 0 &&
            filteredProjectPlugins.length === 0 ? (
            // Filtered to nothing. The canvas beside this owns the recovery
            // action (one CTA when both panes are empty), and the search box
            // carries its own clear button, so this stays a quiet label.
            <div className="flex-1 min-h-0 flex items-start justify-center pt-8 px-3">
              <EmptyState
                className="w-full max-w-[16rem]"
                variant="filtered-empty"
                scale="sidebar"
                title="No matching plugins"
              />
            </div>
          ) : (
            <ScrollShadow
              className="flex-1 min-h-0"
              scrollClassName="p-2 space-y-4"
              aria-label="All plugins"
              data-testid="plugin-list"
            >
              {/* The project's own plugins lead the list: a folder inside the
                  repository the user just opened is the least expected thing
                  here, and burying it under a category would make its
                  provenance the hardest fact to find. */}
              <ProjectPluginSection
                plugins={filteredProjectPlugins}
                selectedId={selectedProjectPluginId}
                onSelect={(id) => {
                  setSelectedPluginId(null);
                  setSelectedProjectPluginId(id);
                }}
              />
              {isSearchActive ? (
                // Flat filtered list — grouping is meaningless across filters
                // like @installed.
                <ul role="list" aria-label="Matching plugins" className="space-y-1">
                  {filteredPlugins.map((plugin) => (
                    <PluginRow
                      key={plugin.manifest.name}
                      plugin={plugin}
                      selected={plugin.manifest.name === selectedPluginId}
                      toggling={pm.pending.has(plugin.manifest.name)}
                      onSelect={() => {
                        setSelectedProjectPluginId(null);
                        setSelectedPluginId((prev) =>
                          prev === plugin.manifest.name ? null : plugin.manifest.name
                        );
                      }}
                      onToggle={() => void pm.handleToggle(plugin)}
                      highlighted={highlightedPluginId === plugin.manifest.name}
                      innerRef={(el) => {
                        if (el) rowRefs.current.set(plugin.manifest.name, el);
                        else rowRefs.current.delete(plugin.manifest.name);
                      }}
                    />
                  ))}
                </ul>
              ) : (
                PLUGIN_CATEGORIES.map(({ id, label }) => {
                  const groupPlugins = groupedPlugins.get(id);
                  if (!groupPlugins || groupPlugins.length === 0) return null;
                  // A real heading over a real list, replacing the old
                  // disabled-option-inside-a-listbox hack: `role="group"` inside
                  // `role="listbox"` drops its label under Chromium + VoiceOver
                  // (LESSON #9006), which is what forced the hack — but the hack
                  // only existed because this was a listbox at all. As a plain
                  // list the categories can be sections with headings, which
                  // screen readers expose in the rotor for free.
                  const headingId = `plugin-category-${id}`;
                  return (
                    <section key={id} aria-labelledby={headingId} className="space-y-1">
                      <h3 id={headingId} className={SECTION_HEADER_CLASS}>
                        {label}{" "}
                        <span className="ml-1.5 normal-case tracking-normal text-text-secondary">
                          {groupPlugins.length}
                        </span>
                      </h3>
                      <ul role="list" className="space-y-1">
                        {groupPlugins.map((plugin) => (
                          <PluginRow
                            key={plugin.manifest.name}
                            plugin={plugin}
                            selected={plugin.manifest.name === selectedPluginId}
                            toggling={pm.pending.has(plugin.manifest.name)}
                            onSelect={() => {
                              setSelectedProjectPluginId(null);
                              setSelectedPluginId((prev) =>
                                prev === plugin.manifest.name ? null : plugin.manifest.name
                              );
                            }}
                            onToggle={() => void pm.handleToggle(plugin)}
                            highlighted={highlightedPluginId === plugin.manifest.name}
                            innerRef={(el) => {
                              if (el) rowRefs.current.set(plugin.manifest.name, el);
                              else rowRefs.current.delete(plugin.manifest.name);
                            }}
                          />
                        ))}
                      </ul>
                    </section>
                  );
                })
              )}
            </ScrollShadow>
          )}
        </div>

        {/* Detail: selected plugin's metadata, actions, and settings. The key
            is on the scroll container (not the pane) so switching plugins
            remounts the whole subtree — resetting scrollTop to the top,
            re-initializing PluginSettingsForm drafts from the new plugin's
            stored values, and resetting the detail subtab to Overview. */}
        <ScrollShadow
          key={
            selectedPlugin?.manifest.name ??
            (selectedProjectPlugin ? `project:${selectedProjectPlugin.id}` : "catalog")
          }
          className="flex-1 min-h-0"
          // A named landmark for whatever is selected, so assistive technology
          // can jump straight to the detail for a plugin instead of hunting for
          // an unlabelled scroll container. Selection does NOT move focus here —
          // that would break sequential exploration of the list.
          role="region"
          aria-label={
            selectedPlugin
              ? `Details for ${pluginLabel(selectedPlugin)}`
              : selectedProjectPlugin
                ? `Details for ${selectedProjectPlugin.displayName}`
                : "Installed plugins"
          }
          // The readable-width caps are left-pinned, which is right for the
          // detail content and the catalog grid but would push the centered
          // no-plugins placeholder off-center in the wide pane — so that case
          // drops the cap. The catalog gets the wider cap; cards auto-fill it.
          scrollClassName={cn(
            "p-6",
            selectedPlugin || selectedProjectPlugin ? "max-w-3xl" : hasAnyPlugins && "max-w-4xl"
          )}
        >
          {selectedProjectPlugin ? (
            <ProjectPluginDetailPane plugin={selectedProjectPlugin} />
          ) : selectedPlugin ? (
            <PluginDetailPane
              plugin={selectedPlugin}
              checkingUpdate={pm.checkingUpdate.has(selectedPlugin.manifest.name)}
              upToDate={pm.upToDateId === selectedPlugin.manifest.name}
              toggling={pm.pending.has(selectedPlugin.manifest.name)}
              onToggle={() => void pm.handleToggle(selectedPlugin)}
              onRetry={() => void pm.retryPlugin(selectedPlugin)}
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
              filtered={isSearchActive}
              hasOtherMatches={filteredProjectPlugins.length > 0}
              onSelect={setSelectedPluginId}
              onClearSearch={clearSearch}
            />
          ) : (
            // No plugins at all — a roomy centered prompt rather than an empty
            // catalog shell; the master column owns the install CTAs.
            <div className="h-full flex flex-col items-center justify-center gap-3 px-6 text-center">
              <Package className="w-8 h-8 text-text-placeholder" aria-hidden="true" />
              <p className="text-base font-medium text-text-primary">No plugin selected</p>
              <p className="text-sm text-text-secondary max-w-sm">
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
        <label className="flex items-center gap-2 text-xs text-text-secondary select-none cursor-pointer">
          <input
            type="checkbox"
            checked={pm.deleteSettings}
            onChange={(e) => pm.setDeleteSettings(e.target.checked)}
            disabled={pm.isUninstalling}
            className="size-3.5 rounded-sm border border-border-default bg-surface-canvas accent-daintree-text/70"
          />
          Also delete this plugin's saved settings
        </label>
        {/* A failed uninstall leaves this dialog open and sets the error, which
            the master column no longer renders while the dialog owns it — so
            without this the failure would be invisible in both places. */}
        {pm.error && (
          <div
            className="mt-3 flex items-start gap-2 p-2 rounded-[var(--radius-md)] bg-status-danger/10 border border-status-danger/20"
            role="alert"
          >
            <AlertCircle
              className="w-3.5 h-3.5 text-status-danger shrink-0 mt-0.5"
              aria-hidden="true"
            />
            <p className="text-2xs text-status-danger break-words">{pm.error}</p>
          </div>
        )}
      </ConfirmDialog>

      <ConfirmDialog
        isOpen={pm.pendingUpdate !== null}
        onClose={pm.isReinstalling ? undefined : () => pm.dismissPendingUpdate()}
        title={pm.pendingUpdate ? `Update '${pluginLabel(pm.pendingUpdate.plugin)}'?` : ""}
        description="Reinstalls the version shown here over the current one. If the download no longer matches it, nothing is installed. Your settings are kept."
        confirmLabel="Reinstall plugin"
        cancelLabel="Cancel"
        onConfirm={() => void pm.confirmReinstall()}
        isConfirmLoading={pm.isReinstalling}
        variant="default"
        zIndex="nested"
      >
        {pm.pendingUpdate && (
          <div className="mt-3 space-y-1.5 text-xs text-text-secondary">
            <div>
              <span className="text-text-secondary">New version</span>{" "}
              <span className="font-medium text-text-primary">
                v{pm.pendingUpdate.result.version}
              </span>
              {pm.pendingUpdate.result.displayName &&
                pm.pendingUpdate.result.displayName !== pluginLabel(pm.pendingUpdate.plugin) && (
                  <span className="text-text-secondary">
                    {" "}
                    · now named {pm.pendingUpdate.result.displayName}
                  </span>
                )}
            </div>
            {pm.pendingUpdate.result.capabilities.length > 0 && (
              <div className="space-y-1.5">
                <span className="text-text-secondary">Capabilities</span>
                {/* Human labels, not raw manifest tokens: this dialog is where
                    a user decides whether an update's privilege change is
                    acceptable, and `fs:project-write` does not say what it
                    grants. Same rows the Permissions tab and the consent
                    dialogs use. */}
                <ul className="space-y-1.5">
                  {pm.pendingUpdate.result.capabilities.map((cap) => (
                    <CapabilityRow key={cap} capability={cap} />
                  ))}
                </ul>
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
            Enter the URL of a Daintree plugin archive (.dntr). It&rsquo;s downloaded, validated,
            and installed.
          </AppDialog.Description>
          {/* The security note is the reason to hesitate, so it stops sharing a
              paragraph — and a weight — with the mechanics of the field above. */}
          <div className="flex items-start gap-2 p-2 rounded-[var(--radius-md)] bg-status-warning/10 border border-status-warning/20">
            <AlertTriangle
              className="w-3.5 h-3.5 text-status-warning shrink-0 mt-0.5"
              aria-hidden="true"
            />
            <p className="text-2xs text-status-warning">
              Plugins run with full Node.js privileges — no sandbox, no signature check, and no
              capability prompt before install. Only install from sources you trust.
            </p>
          </div>
          {/* A correctable failure keeps this dialog open, but the only error
              slot was the master column behind the scrim — so the user sat in an
              open dialog with the explanation hidden underneath it. */}
          {pm.error && (
            <div
              className="flex items-start gap-2 p-2 rounded-[var(--radius-md)] bg-status-danger/10 border border-status-danger/20"
              role="alert"
            >
              <AlertCircle
                className="w-3.5 h-3.5 text-status-danger shrink-0 mt-0.5"
                aria-hidden="true"
              />
              <p className="text-2xs text-status-danger break-words">{pm.error}</p>
            </div>
          )}
          <input
            type="url"
            value={pm.urlInput}
            onChange={(e) => pm.setUrlInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && pm.urlInput.trim()) void pm.handleInstallFromUrl();
            }}
            placeholder="https://example.com/plugin.dntr"
            className="w-full px-3 py-2 text-sm rounded-[var(--radius-md)] bg-surface-canvas border border-border-interactive text-text-primary placeholder:text-text-secondary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary"
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
