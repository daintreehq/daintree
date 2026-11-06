import type { PluginHostApi } from "../../../../shared/types/plugin.js";
import type { Catalog } from "./catalog.js";
import type { IndexStore } from "./indexStore.js";

export const MANIFEST_NAME = "daintreehq.continue-session";

export interface PluginContext {
  readonly host: PluginHostApi;
  readonly catalog: Catalog;
  readonly store: IndexStore;
  readonly newId: () => string;
  /** Conversions in flight, aborted when the plugin unloads. */
  readonly running: Set<AbortController>;
}

/** The project in front, which is where an installed plugin's dispatch runs. */
export async function currentProjectId(host: PluginHostApi): Promise<string | null> {
  const current = await host.dispatch("project.getCurrent");
  if (!current.ok) return null;
  const project = (current.result as { project?: { id?: unknown } | null }).project;
  return typeof project?.id === "string" ? project.id : null;
}
