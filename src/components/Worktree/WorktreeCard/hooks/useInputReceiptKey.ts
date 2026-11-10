import { useLayoutEffect, useState } from "react";
import { panelStoreApi } from "@/store/panelStore";

/**
 * Emits a monotonically increasing key whenever a new input-time ping
 * (`pingSeq` advanced) targets one of `terminalIds`. Consumers mount a keyed
 * overlay element on the returned key so each ping replays the one-shot CSS
 * animation.
 *
 * The ping state is read through an imperative store subscription, not a hook
 * selector: `pingTerminal` runs on every focus change and keystroke, and a
 * selector over the raw `pingedId`/`pingSeq` would re-render every mounted
 * card twice per ping (set, then the 1.6s clear). Here only the card that owns
 * the pinged terminal sets state.
 *
 * `pingSeq` (rather than `pingedId` alone) is the authoritative trigger:
 * tapping the same row twice within the live window holds `pingedId` constant
 * but advances `pingSeq`, so both taps produce a receipt. The 1.6s clear to
 * null never advances `pingSeq`, so it is ignored: the receipt acknowledges
 * input, not its absence. Only a change after the subscription starts counts,
 * so a card mounting mid-session with a still-live ping stays quiet.
 */
export function useInputReceiptKey(terminalIds: readonly string[]): number {
  const [receiptKey, setReceiptKey] = useState(0);

  // A layout effect, so the subscription is live before anything outside React
  // can ping between this render committing and a passive effect flushing.
  useLayoutEffect(() => {
    if (terminalIds.length === 0) return;
    return panelStoreApi.subscribe((state, prev) => {
      if (state.pingSeq === prev.pingSeq) return;
      const { pingedId } = state;
      if (pingedId && terminalIds.includes(pingedId)) {
        setReceiptKey((k) => k + 1);
      }
    });
  }, [terminalIds]);

  return receiptKey;
}
