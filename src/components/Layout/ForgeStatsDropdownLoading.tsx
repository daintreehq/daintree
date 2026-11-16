import { FORGE_DROPDOWN_PANEL_SIZE } from "./forgeStatsDropdownContract";

/**
 * A stats dropdown body whose own chunk hasn't arrived: the panel's box, empty.
 * That chunk is a local read, well inside the 400ms gate where a wait shows
 * nothing; the body draws its own skeleton for the data fetch that follows.
 * The box keeps the panel from opening as a sliver and growing a frame later.
 */
export function ForgeStatsDropdownLoading() {
  return <div aria-busy="true" className={FORGE_DROPDOWN_PANEL_SIZE} />;
}
