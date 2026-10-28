import { useEffect } from "react";
import {
  isHoldingUnrecoverableWork,
  subscribeUnrecoverableWork,
} from "@/services/plugin/panelRecoveryHold";

/**
 * Tells Main whether this view holds work that destroying it would lose.
 *
 * Two halves of one answer. Automatic Sleep asks and waits for the reply,
 * which comes from plain state inside the IPC callback, so a cached view
 * answers without rendering or waiting on a frame; a throw leaves the query
 * unanswered, which Main reads as holding. Eviction cannot wait, so the same
 * answer is also pushed on mount and whenever it flips, and Main reads the
 * last one it got (#14095).
 */
export function usePanelRecoveryResponder() {
  useEffect(() => {
    const project = window.electron.project;
    const offQuery = project.onPanelRecoveryQuery((requestId) => {
      project.replyPanelRecovery(requestId, isHoldingUnrecoverableWork());
    });
    let reported: boolean | null = null;
    const report = () => {
      const holding = isHoldingUnrecoverableWork();
      if (holding === reported) return;
      reported = holding;
      project.reportPanelRecoveryState(holding);
    };
    report();
    const offChanges = subscribeUnrecoverableWork(report);
    return () => {
      offQuery();
      offChanges();
    };
  }, []);
}
