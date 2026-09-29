import { useEffect, useState, type ComponentType } from "react";
import {
  pluginSettingsViewKindId,
  type LoadedPluginInfo,
  type PluginSettingsViewContext,
} from "@shared/types/plugin";
import { SettingsGroup, SettingsRow } from "@/components/Settings/SettingsGroup";
import {
  makePluginViewContent,
  type PluginViewContentProps,
} from "@/components/Plugin/PluginViewContent";
import { pluginDeclaresSettingsView } from "@/services/plugin/pluginSettingsHome";
import { stripPluginViewGeneration } from "@shared/utils/pluginViewUrl";
import { usePluginRuntimeStatusStore } from "@/store/pluginRuntimeStatusStore";
import { logError } from "@/utils/logger";

/**
 * One plugin's settings-view runtime: the content factory, the module URL it was
 * minted for, and the removal signal that stands in for a panel record's.
 */
interface SettingsViewRuntime {
  componentPath: string;
  /** The view generation baked into `componentPath`, or `null` if it has none. */
  generation: number | null;
  content: ComponentType<PluginViewContentProps>;
  removal: AbortController;
}

const runtimes = new Map<string, SettingsViewRuntime>();
/** Inventory re-reads a reloaded section makes before saying it couldn't load. */
const VIEW_REFRESH_ATTEMPTS = 5;
const VIEW_REFRESH_RETRY_MS = 400;
let unsubscribeLifecycle: (() => void) | null = null;

/** The `__dtv-N` generation of a `plugin://` module URL, or `null` for none. */
function viewGenerationOf(componentPath: string): number | null {
  try {
    const pathname = new URL(componentPath).pathname.replace(/^\/+/, "");
    return stripPluginViewGeneration(pathname)?.generation ?? null;
  } catch {
    return null;
  }
}

/** Abort a runtime's removal signal and drop its factory. */
function retire(pluginId: string): void {
  const runtime = runtimes.get(pluginId);
  if (!runtime) return;
  runtime.removal.abort();
  runtimes.delete(pluginId);
}

/**
 * Retire runtimes as their plugins stop or reload, whether or not a settings
 * page is open.
 *
 * A settings view has no panel kind whose removal broadcast could tell it the
 * plugin is gone, and the homes are only mounted while a page shows. The one
 * app-wide signal that covers every way a plugin stops — disabled, muted,
 * uninstalled, its project trust withdrawn — and every reload is main's
 * runtime-status push: a `null` status means the instance left the inventory,
 * and a new `viewGeneration` means it now serves a different module. Either
 * retires the cached runtime, so its removal signal aborts then rather than on
 * some later visit. Subscribed on first use and kept for the life of the
 * renderer, like the map it sweeps.
 */
function ensureLifecycleSubscription(): void {
  if (unsubscribeLifecycle !== null) return;
  const events = typeof window === "undefined" ? undefined : window.electron?.events;
  if (typeof events?.on !== "function") return;
  unsubscribeLifecycle = events.on("plugin:runtime-status-changed", ({ pluginId, status }) => {
    const runtime = runtimes.get(pluginId);
    if (!runtime) return;
    if (
      status === null ||
      status.viewGeneration === null ||
      (runtime.generation !== null && status.viewGeneration !== runtime.generation)
    ) {
      retire(pluginId);
    }
  });
}

/**
 * The content factory for a plugin's settings view, minted once per module URL.
 *
 * `makePluginViewContent` must run outside render — a factory minted during
 * render is a new component type each time, which would remount the view and
 * restart its `plugin://` import on every render of the settings page. A
 * reloaded plugin gets a fresh generation segment in its URL, so a new path
 * retires the old runtime (aborting its removal signal) rather than reusing a
 * factory bound to the old module.
 */
function getRuntime(plugin: LoadedPluginInfo, componentPath: string): SettingsViewRuntime {
  ensureLifecycleSubscription();
  const pluginId = plugin.instanceId;
  const existing = runtimes.get(pluginId);
  if (existing !== undefined && existing.componentPath === componentPath) return existing;
  existing?.removal.abort();
  const runtime: SettingsViewRuntime = {
    componentPath,
    generation: viewGenerationOf(componentPath),
    content: makePluginViewContent({
      id: pluginSettingsViewKindId(pluginId),
      name: `${plugin.manifest.displayName ?? plugin.manifest.name} settings`,
      componentPath,
      extensionId: pluginId,
      standalone: true,
    }),
    removal: new AbortController(),
  };
  runtimes.set(pluginId, runtime);
  return runtime;
}

/** Test-only: drop every cached factory, its removal signal and the subscription. */
export function _resetPluginSettingsViewRuntimesForTest(): void {
  for (const runtime of runtimes.values()) runtime.removal.abort();
  runtimes.clear();
  unsubscribeLifecycle?.();
  unsubscribeLifecycle = null;
}

/** Test-only: the removal signal of a plugin's cached runtime, if it has one. */
export function _settingsViewRemovalSignalForTest(pluginId: string): AbortSignal | undefined {
  return runtimes.get(pluginId)?.removal.signal;
}

/**
 * A plugin's custom settings section (`contributes.views` with `location:
 * "settings"`), mounted in its settings home below the declared fields.
 *
 * The host owns the chrome: the section heading is the home's own, and the
 * view renders its rows inside this one `SettingsGroup` surface, so a custom
 * section reads as more rows of the same settings rather than a panel pasted
 * into a page. The content is the shared plugin-view loader — the same
 * activation, error boundary and "Try again" a panel gets — so a view that
 * throws shows the diagnostics pane in place, and the rest of the page keeps
 * working. There is no dialog-level Save: the view applies its own changes as
 * they are made, like every other settings row.
 *
 * Contained the way a project surface is: `isolate` caps the view's z-indexes
 * in its own stacking context, and `contain: layout paint` with overflow
 * clipping keeps a `position: fixed` descendant inside the group, so no view
 * can paint over the settings page around it.
 *
 * A plugin that declares a section but isn't running has no module to load.
 * The section still shows, as one row saying what it needs, rather than
 * vanishing and leaving the user to guess where it went.
 */
export function PluginSettingsView({
  plugin,
  context,
  running = true,
}: {
  plugin: LoadedPluginInfo;
  context: PluginSettingsViewContext;
  /** False while the home knows the plugin is stopped, even if its list is stale. */
  running?: boolean;
}) {
  const liveGeneration = usePluginRuntimeStatusStore(
    (s) => s.statusById.get(plugin.instanceId)?.viewGeneration ?? null
  );
  const initRuntimeStatus = usePluginRuntimeStatusStore((s) => s.init);
  useEffect(() => initRuntimeStatus(), [initRuntimeStatus]);
  // A reload serves the view from a new module URL — new generation, new
  // plugin:// authority — that only a fresh inventory read carries, and the
  // homes don't re-read on a dev reload. The one this section fetched itself,
  // if the props are behind the live generation.
  const [fetchedPath, setFetchedPath] = useState<string | null>(null);
  // The inventory can lag the status push by a beat; a few spaced re-reads
  // cover that, and past them the section says so instead of waiting forever.
  const [refreshAttempt, setRefreshAttempt] = useState(0);
  const propsPath = plugin.settingsViewPath;
  const latestPath =
    fetchedPath !== null && viewGenerationOf(fetchedPath) === liveGeneration
      ? fetchedPath
      : propsPath;
  const stale =
    latestPath !== undefined &&
    liveGeneration !== null &&
    viewGenerationOf(latestPath) !== liveGeneration;
  const instanceId = plugin.instanceId;
  const refreshExhausted = refreshAttempt >= VIEW_REFRESH_ATTEMPTS;
  useEffect(() => {
    if (!stale || !running || refreshExhausted) return;
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    window.electron.plugin
      .list()
      .then((list) => {
        if (cancelled) return;
        const next = list.find((p) => p.instanceId === instanceId)?.settingsViewPath;
        if (next && viewGenerationOf(next) === liveGeneration) {
          setFetchedPath(next);
          return;
        }
        retry = setTimeout(() => setRefreshAttempt((n) => n + 1), VIEW_REFRESH_RETRY_MS);
      })
      .catch((err: unknown) => {
        logError(`Failed to refresh ${instanceId}'s settings view`, err);
        if (!cancelled) setRefreshAttempt(VIEW_REFRESH_ATTEMPTS);
      });
    return () => {
      cancelled = true;
      if (retry !== undefined) clearTimeout(retry);
    };
  }, [stale, running, instanceId, liveGeneration, refreshAttempt, refreshExhausted]);
  // A new generation starts a fresh round of attempts.
  const [attemptsFor, setAttemptsFor] = useState(liveGeneration);
  if (attemptsFor !== liveGeneration) {
    setAttemptsFor(liveGeneration);
    setRefreshAttempt(0);
  }

  if (!pluginDeclaresSettingsView(plugin)) return null;
  // Never mount the retired module: until the new URL is in, the section waits.
  const componentPath = running && !stale ? latestPath : undefined;
  if (running && stale) {
    return (
      <SettingsGroup>
        <SettingsRow
          label="More settings"
          description={
            refreshExhausted
              ? "Couldn't load the reloaded section. Close and reopen Settings to try again."
              : "Reloading…"
          }
        />
      </SettingsGroup>
    );
  }
  if (!componentPath) {
    return (
      <SettingsGroup>
        <SettingsRow
          label="More settings"
          description={
            plugin.disabled
              ? "Available when the plugin is enabled"
              : "Available while the plugin is running"
          }
        />
      </SettingsGroup>
    );
  }
  const { content: Content, removal } = getRuntime(plugin, componentPath);
  return (
    <SettingsGroup>
      <div
        className="relative isolate flex min-w-0 flex-col overflow-hidden"
        style={{ contain: "layout paint" }}
        data-testid="plugin-settings-view"
      >
        <Content
          // Keyed by home: the manager and the project page each hold their own
          // mount, and a view's per-mount state belongs to one of them.
          panelId={`settings:${plugin.instanceId}:${context.scope}`}
          panelRemovedSignal={removal.signal}
          settingsContext={context}
        />
      </div>
    </SettingsGroup>
  );
}
