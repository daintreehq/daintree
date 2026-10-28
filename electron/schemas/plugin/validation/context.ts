import type { PluginCapability, PluginOrigin } from "../../../../shared/types/plugin.js";
import type { ParsedPluginManifest } from "../manifestShape.js";

/**
 * What every cross-contribution validator may read besides the manifest
 * itself: the discovering origin, and the declared ids and capabilities
 * indexed once per parse.
 */
export interface ManifestValidationContext {
  readonly origin: PluginOrigin;
  readonly projectRuntime: boolean;
  readonly ownNamespacePrefix: string;
  readonly capabilities: ReadonlySet<PluginCapability>;
  readonly declaredCommandActionIds: ReadonlySet<string>;
  readonly settingIds: ReadonlySet<string>;
  readonly viewIds: ReadonlySet<string>;
  readonly settingsViewIds: ReadonlySet<string>;
  readonly fileEditorViewIds: ReadonlySet<string>;
  readonly sidebarViewIds: ReadonlySet<string>;
  readonly panelIds: ReadonlySet<string>;
  readonly ptyPanelIds: ReadonlySet<string>;
}

export function buildManifestValidationContext(
  manifest: ParsedPluginManifest,
  origin: PluginOrigin
): ManifestValidationContext {
  // An instanced installed package runs under the same project binding as a
  // project-local plugin, so it takes the same contribution restrictions.
  const projectRuntime = manifest.scope === "project" || manifest.instanceMode === "project";
  const ownNamespacePrefix = `${manifest.name}.`;
  const declaredCommandActionIds = new Set(
    manifest.contributes.commands.map((cmd) => `${manifest.name}.${cmd.id}`)
  );
  // Cross-reference integrity — a contribution that names another by id must
  // point at one that exists in the same manifest, else the reference dangles
  // and the wiring silently no-ops at runtime.
  const settingIds = new Set(manifest.contributes.settings.map((setting) => setting.id));
  const viewIds = new Set(manifest.contributes.views.map((view) => view.id));
  const settingsViewIds = new Set(
    manifest.contributes.views.filter((view) => view.location === "settings").map((v) => v.id)
  );
  const fileEditorViewIds = new Set(
    manifest.contributes.views
      .filter((view) => view.location === "fileEditor")
      .map((view) => view.id)
  );
  const sidebarViewIds = new Set(
    manifest.contributes.views.filter((view) => view.location === "sidebar").map((v) => v.id)
  );
  const panelIds = new Set(manifest.contributes.panels.map((panel) => panel.id));
  const ptyPanelIds = new Set(
    manifest.contributes.panels.filter((p) => p.hasPty === true).map((p) => p.id)
  );
  return {
    origin,
    projectRuntime,
    ownNamespacePrefix,
    capabilities: new Set(manifest.capabilities),
    declaredCommandActionIds,
    settingIds,
    viewIds,
    settingsViewIds,
    fileEditorViewIds,
    sidebarViewIds,
    panelIds,
    ptyPanelIds,
  };
}
