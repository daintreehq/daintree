import type { ComponentType } from "react";
import {
  pluginSettingsViewKindId,
  type LoadedPluginInfo,
  type PluginSettingsViewContext,
} from "@shared/types/plugin";
import { SettingsGroup } from "@/components/Settings/SettingsGroup";
import {
  makePluginViewContent,
  type PluginViewContentProps,
} from "@/components/Plugin/PluginViewContent";

/**
 * One plugin's settings-view runtime: the content factory, the module URL it was
 * minted for, and the removal signal that stands in for a panel record's.
 */
interface SettingsViewRuntime {
  componentPath: string;
  content: ComponentType<PluginViewContentProps>;
  removal: AbortController;
}

const runtimes = new Map<string, SettingsViewRuntime>();

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
  const pluginId = plugin.instanceId;
  const existing = runtimes.get(pluginId);
  if (existing !== undefined && existing.componentPath === componentPath) return existing;
  existing?.removal.abort();
  const runtime: SettingsViewRuntime = {
    componentPath,
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

/** Test-only: drop every cached factory and its removal signal. */
export function _resetPluginSettingsViewRuntimesForTest(): void {
  for (const runtime of runtimes.values()) runtime.removal.abort();
  runtimes.clear();
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
 * `isolate` caps the view's z-indexes inside its own stacking context, so it
 * cannot paint over the settings page around it.
 */
export function PluginSettingsView({
  plugin,
  context,
}: {
  plugin: LoadedPluginInfo;
  context: PluginSettingsViewContext;
}) {
  const componentPath = plugin.settingsViewPath;
  if (!componentPath) return null;
  const { content: Content, removal } = getRuntime(plugin, componentPath);
  return (
    <SettingsGroup>
      <div className="relative isolate flex min-w-0 flex-col" data-testid="plugin-settings-view">
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
