import type { WhenClauseContext } from "@shared/utils/whenClause/types";
import { isPtyPanel } from "@shared/types/panel";
import { usePaletteStore, usePanelStore } from "@/store";
import { useFleetArmingStore } from "@/store/fleetArmingStore";
import { useMacroFocusStore } from "@/store/macroFocusStore";

/**
 * Live `when`-clause context for keybinding resolution — the documented
 * contract for plugin keybinding `when` expressions (see
 * docs/plugins/contribution-points.md). Built lazily, at most once per
 * keydown, only when a candidate binding carries a `when` clause.
 *
 * Every key here is a stable public API: additions are fine, renames and
 * semantic changes are breaking. Unknown identifiers evaluate falsy in the
 * evaluator — note that makes negated expressions permissive: a misspelled
 * `!modalOpne` is always true, so a typo can broaden a binding rather than
 * disable it.
 */
export function buildKeybindingWhenContext(event: KeyboardEvent): WhenClauseContext {
  const target = event.target instanceof Element ? event.target : null;
  const paletteId = usePaletteStore.getState().activePaletteId;
  const { armedIds } = useFleetArmingStore.getState();
  const { panelsById } = usePanelStore.getState();

  let fleetWaiting = false;
  for (const id of armedIds) {
    const panel = panelsById[id];
    if (panel && isPtyPanel(panel) && panel.agentState === "waiting") {
      fleetWaiting = true;
      break;
    }
  }

  return {
    terminalFocused: target?.closest(".xterm") !== null && target !== null,
    modalOpen: document.querySelector('[role="dialog"][aria-modal="true"]') !== null,
    paletteOpen: paletteId !== null,
    paletteId: paletteId ?? "",
    fleetArmed: armedIds.size > 0,
    fleetWaiting,
    sidebarVisible: useMacroFocusStore.getState().visibility.sidebar,
  };
}
