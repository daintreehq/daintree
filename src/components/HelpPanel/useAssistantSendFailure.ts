import { useCallback, useRef, useState } from "react";
import { formatErrorMessage } from "@shared/utils/errorMessage";

export type AssistantSendKind = "message" | "key";

export interface AssistantSendFailure {
  /** The run it was sent to; a failure only shows while that run is the one on screen. */
  runKey: string;
  kind: AssistantSendKind;
  reason: string;
}

export interface AssistantSendAttempt {
  sent: () => void;
  failed: (reason: string) => void;
}

const UNKNOWN_REASON = "The assistant didn't take it.";

/** Main's own words for why it refused, or a plain line when it gave none. */
export function refusalReason(error: unknown): string {
  return formatErrorMessage(error, UNKNOWN_REASON).trim() || UNKNOWN_REASON;
}

/**
 * The last send or key the global assistant refused. It lives above the
 * terminal because taking or losing input remounts that, and a refusal that
 * lands as input moves is the one most worth saying.
 *
 * The latest attempt of each kind decides: a slow refusal can't overwrite what
 * a newer send did, and a newer success can't be undone by an older failure.
 * A sent message clears every failure, since the draft is gone; a sent key
 * clears only a key failure, since an unsent message is still in the box.
 */
export function useAssistantSendFailure(runKey: string | null) {
  const [failure, setFailure] = useState<AssistantSendFailure | null>(null);
  const latest = useRef<Record<AssistantSendKind, number>>({ message: 0, key: 0 });

  const start = useCallback((kind: AssistantSendKind, forRun: string): AssistantSendAttempt => {
    const attempt = ++latest.current[kind];
    const isLatest = () => latest.current[kind] === attempt;
    // Sending again says nothing until it settles, so a repeat refusal reads as a new one.
    if (kind === "message") setFailure((was) => (was?.kind === "message" ? null : was));
    return {
      sent: () => {
        if (!isLatest()) return;
        setFailure((was) => (kind === "message" || was?.kind === "key" ? null : was));
      },
      failed: (reason) => {
        if (!isLatest()) return;
        setFailure({ runKey: forRun, kind, reason });
      },
    };
  }, []);

  return { failure: failure?.runKey === runKey ? failure : null, start };
}
