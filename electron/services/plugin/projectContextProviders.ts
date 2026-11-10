import type { ContextProviderEntry } from "../../../shared/types/pluginContextProvider.js";
import {
  arbitrateContextProviders,
  getRegisteredContextProviders,
} from "../contextProviderRegistry.js";
import { withHostContextProviders } from "../issueContextProvider.js";
import { getContextProvidersOff } from "./contextProvidersOff.js";
import { selectContributionsForProject } from "./PluginContributionBroadcaster.js";

/**
 * The `@` context providers a view of `projectId` sees (#13795), each with
 * whether it holds its prefix there, was refused it, or is switched off. The
 * host's `@issue:` (#16382) comes first, so it holds `issue` unless the user
 * switches it off.
 */
export function listContextProvidersForProject(projectId: string | null): ContextProviderEntry[] {
  const visible = withHostContextProviders(
    selectContributionsForProject(
      getRegisteredContextProviders(),
      (entry) => entry.pluginId,
      projectId
    ),
    projectId
  );
  if (visible.length === 0) return [];
  const off = getContextProvidersOff();
  return arbitrateContextProviders(visible, (pluginId) => off.has(pluginId));
}
