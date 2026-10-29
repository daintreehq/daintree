import { useEffect, useState } from "react";
import { usePanelStore } from "@/store/panelStore";
import { useVoiceRecordingStore } from "@/store/voiceRecordingStore";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import { useFleetArmingStore } from "@/store/fleetArmingStore";
import { useCanopyStore } from "@/store/canopyStore";
import { useHelpPanelStore } from "@/store/helpPanelStore";
import { useMacroFocusStore } from "@/store/macroFocusStore";
import { subscribeTerminalInputGate } from "@/services/terminal/inputGate";
import {
  resolveRecentDictationDestination,
  type RecentDictationDestination,
} from "@/services/recentDictationRecovery";

function sameDestination(a: RecentDictationDestination, b: RecentDictationDestination): boolean {
  if (a.ok) return b.ok && a.target.panelId === b.target.panelId && a.label === b.label;
  return !b.ok && a.reason === b.reason;
}

/**
 * Where a recovered dictation would go, kept current while `active` so the
 * palette and menu can name it, or say why there's nowhere, before the pick
 * (#15127). The voice store ticks with the mic level while recording, so an
 * unchanged answer keeps its identity rather than re-rendering the caller.
 */
export function useRecentDictationDestination(active: boolean): RecentDictationDestination {
  const [destination, setDestination] = useState(resolveRecentDictationDestination);

  useEffect(() => {
    if (!active) return undefined;
    const update = () =>
      setDestination((prev) => {
        const next = resolveRecentDictationDestination();
        return sameDestination(prev, next) ? prev : next;
      });
    update();
    const stops = [
      usePanelStore.subscribe(update),
      useVoiceRecordingStore.subscribe(update),
      useTerminalInputStore.subscribe(update),
      useFleetArmingStore.subscribe(update),
      useCanopyStore.subscribe(update),
      useHelpPanelStore.subscribe(update),
      useMacroFocusStore.subscribe(update),
      subscribeTerminalInputGate(update),
    ];
    return () => stops.forEach((stop) => stop());
  }, [active]);

  return destination;
}
