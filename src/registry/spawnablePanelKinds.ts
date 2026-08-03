import {
  getPanelKindIds,
  getPanelKindConfig,
  type PanelKindConfig,
} from "@shared/config/panelKindRegistry";
import { getPanelKindDefinition } from "./panelKindRegistry";

/**
 * Panel kinds a user can spawn from a bare launcher entry — the ⌘⇧P palette and
 * the dock's `+` launcher read the same set so the two can't drift.
 *
 * A kind qualifies when it declares itself palette-visible and has a registered
 * renderer definition. `"agent"` is reserved (it names the agent-backed terminal
 * family, not a spawnable surface), and kinds that need a target to make sense
 * opt out with `showInPalette: false` — `diff` (needs a file) and `terminal`
 * (has dedicated spawn actions). Plugin kinds are included: `getPanelKindIds`
 * reads the merged registry, so a kind registered mid-session is picked up by
 * the next call rather than needing its own subscription.
 */
export function getSpawnablePanelKinds(): PanelKindConfig[] {
  const configs: PanelKindConfig[] = [];
  for (const kindId of getPanelKindIds()) {
    if (kindId === "agent") continue;
    const config = getPanelKindConfig(kindId);
    if (!config) continue;
    if (config.showInPalette === false) continue;
    if (!getPanelKindDefinition(kindId)) continue;
    configs.push(config);
  }
  return configs;
}
