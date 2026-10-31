import type { WhenClauseContext } from "@shared/utils/whenClause/types";
import { isPtyPanel } from "@shared/types/panel";
import { usePaletteStore, usePanelStore } from "@/store";
import { useFleetArmingStore } from "@/store/fleetArmingStore";
import { useMacroFocusStore } from "@/store/macroFocusStore";
import { useCanopyStore } from "@/store/canopyStore";
import { useVoiceRecordingStore } from "@/store/voiceRecordingStore";
import { getChromeWhenContext } from "@/services/chromeWhenContext";
import { isInPaneDialog } from "@/lib/paneDialog";
import { hasAppModal } from "@/lib/appModal";

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
 *
 * The shared chrome context comes first — plugin `host.setContext` keys under
 * their manifest name (`acme.beads.needsYou`), this view's project facts and
 * its presentation levels — and the focus and UI keys below are added on top.
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

  const inTerminal = target?.closest(".xterm") !== null && target !== null;
  const editable =
    target instanceof HTMLElement &&
    (target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.isContentEditable === true);

  const voice = useVoiceRecordingStore.getState();

  return {
    ...getChromeWhenContext(),
    terminalFocused: inTerminal,
    // xterm's own input is a textarea; it doesn't count as a text field.
    textInputFocused: editable && !inTerminal,
    // A page's dialog blocks only its own pane: open as far as the keys typed
    // into it are concerned, and nowhere else (#15037).
    modalOpen: hasAppModal() || isInPaneDialog(target),
    paletteOpen: paletteId !== null,
    paletteId: paletteId ?? "",
    fleetArmed: armedIds.size > 0,
    fleetWaiting,
    sidebarVisible: useMacroFocusStore.getState().visibility.sidebar,
    canopyHidden: useCanopyStore.getState().mode === "hidden",
    // Starting, running or finishing here, or running in another view.
    dictationActive:
      (voice.status !== "idle" && voice.status !== "error") ||
      voice.pendingTarget !== null ||
      voice.sessionElsewhere !== null,
  };
}
