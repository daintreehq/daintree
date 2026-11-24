import { isWebContentsFrozen, onFrozenStateChange } from "../utils/webContentsLifecycle.js";
import { getRegisteredProjectViews, onRendererScopeChanged } from "./webContentsRegistry.js";

/**
 * Projects with at least one local view, every one of which may be CDP-frozen
 * (#17038). A project with no view at all is left out: the set only ever
 * withholds output from views that exist and cannot read it.
 */
export function getFrozenViewProjectIds(): string[] {
  const frozen = new Set<string>();
  const readable = new Set<string>();
  for (const { webContents, projectId } of getRegisteredProjectViews()) {
    (isWebContentsFrozen(webContents) ? frozen : readable).add(projectId);
  }
  return [...frozen].filter((projectId) => !readable.has(projectId)).sort();
}

/**
 * Keep `publish` told of {@link getFrozenViewProjectIds}: now, then whenever a
 * renderer's freeze flips or the set of project views changes, and only when
 * the set itself moved. Returns the stop.
 */
export function startFrozenViewProjectsPublisher(
  publish: (projectIds: string[]) => void
): () => void {
  // The host starts with an empty set, so an empty one needs no message.
  let published = "[]";
  const sync = (): void => {
    const projectIds = getFrozenViewProjectIds();
    const serialized = JSON.stringify(projectIds);
    if (serialized === published) return;
    published = serialized;
    publish(projectIds);
  };
  const stopFrozen = onFrozenStateChange(() => sync());
  const stopScope = onRendererScopeChanged(sync);
  sync();
  return () => {
    stopFrozen();
    stopScope();
  };
}
