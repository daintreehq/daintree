import { useEffect, useState } from "react";
import type { DecisionsRelayRemoval, DecisionsStatus } from "@shared/types/decisions";

/** What main says of a removal pane: its removal, or that it watches none under this id. */
export type RelayRemovalObservation = DecisionsRelayRemoval | { unwatched: true };

/**
 * The guided relay removal (#16202) main watches under `terminalId`, from the
 * Decisions status: read once, then followed on every push, the higher
 * revision winning. Null until the first answer, and always for a pane that
 * isn't a removal's, which reads and subscribes to nothing.
 */
export function useRelayRemoval(
  terminalId: string,
  enabled: boolean
): RelayRemovalObservation | null {
  const [observed, setObserved] = useState<{
    terminalId: string;
    value: RelayRemovalObservation;
  } | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let revision = -1;
    const accept = (status: DecisionsStatus) => {
      const next = status.revision ?? 0;
      if (!active || next < revision) return;
      revision = next;
      const removal = status.relayRemovals?.find((entry) => entry.terminalId === terminalId);
      setObserved({ terminalId, value: removal ?? { unwatched: true } });
    };
    // Subscribed before the read, so a change between the two is never missed.
    const off = window.electron.events.on("decisions:status-changed", accept);
    window.electron.decisions.getStatus().then(accept, () => {
      // A push already answered; a failed read has nothing newer to say.
      if (active && revision < 0) setObserved({ terminalId, value: { unwatched: true } });
    });
    return () => {
      active = false;
      off();
    };
  }, [terminalId, enabled]);

  return enabled && observed?.terminalId === terminalId ? observed.value : null;
}
