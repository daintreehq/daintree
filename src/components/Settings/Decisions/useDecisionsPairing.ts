import { useEffect, useEffectEvent, useRef, useState } from "react";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import type {
  DecisionsPairingInvitation,
  DecisionsPairingState,
  DecisionsPairingStartResult,
} from "@shared/types/decisions";
import { describeRelayRequestFailure } from "./devicesCopy";

/** How often an open invitation asks main whether a phone has answered. */
export const PAIRING_POLL_MS = 2000;

export interface PairingAnswer {
  code: string;
  label: string;
  role: "phone" | "tablet";
}

export type PairingPhase =
  | { phase: "idle" }
  | { phase: "starting" }
  | { phase: "start-failed"; message: string }
  | { phase: "waiting"; invitation: DecisionsPairingInvitation }
  | {
      phase: "responded";
      invitation: DecisionsPairingInvitation;
      answer: PairingAnswer;
      /** Approving is in flight. */
      approving: boolean;
      /**
       * An approval was sent. The relay may have taken it even if no answer
       * came back, so the deadline passing doesn't end this phase: checks
       * carry on until main says it paired or lapsed.
       */
      approvalSent: boolean;
      /** Why the last approval didn't go through, when it can be tried again. */
      approveError: string | null;
    }
  | { phase: "paired"; label: string }
  | { phase: "expired" }
  | { phase: "declined" }
  | { phase: "changed" };

export interface UseDecisionsPairingResult {
  state: PairingPhase;
  /** Why the latest check with the relay failed; checks carry on. */
  pollProblem: string | null;
  /** The wall clock, ticking each second while an invitation is open, for its countdown. */
  now: number;
  start(): void;
  approve(): void;
  /** The codes didn't match: the relay rejects the invitation. */
  decline(): void;
  /** The dialog closed: an open invitation is rejected, and everything here resets. */
  cancel(): void;
}

function startFailure(result: Exclude<DecisionsPairingStartResult, { result: "started" }>): string {
  switch (result.result) {
    case "full":
      return "Your relay already holds as many devices as it allows, so it can't take another.";
    case "busy":
      return "Your relay has the most pairing codes open that it allows. One lapses within five minutes; try again then.";
    default:
      return describeRelayRequestFailure(result);
  }
}

/**
 * One pairing at a time (#16009): an invitation, then a check every
 * `PAIRING_POLL_MS` until a phone answers, the code the person compares, and
 * approval or decline. Answers for an invitation that is no longer the
 * current one are dropped. Promise chains rather than try/finally, which the
 * React Compiler can't lower.
 */
export function useDecisionsPairing(
  options: {
    /** A phone was paired, by this dialog or by an approval it sent before it closed. */
    onPaired?: () => void;
  } = {}
): UseDecisionsPairingResult {
  const { onPaired } = options;
  const notifyPaired = useEffectEvent(() => onPaired?.());
  const [state, setState] = useState<PairingPhase>({ phase: "idle" });
  const [pollProblem, setPollProblem] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const currentId = useRef<string | null>(null);
  /** Bumped by every start and cancel, so a start answered after it was given up is declined. */
  const startGeneration = useRef(0);

  const open = state.phase === "waiting" || state.phase === "responded" ? state.invitation : null;
  const openId = open?.pairingId ?? null;
  const expiresAt = open?.expiresAt ?? null;
  const approving = state.phase === "responded" && state.approving;

  // The countdown, and the lapse it ends in, from this computer's clock.
  useEffect(() => {
    if (expiresAt === null) return;
    setNow(Date.now());
    const timer = window.setInterval(() => {
      const at = Date.now();
      setNow(at);
      if (at >= expiresAt) {
        setState((prev) =>
          (prev.phase === "waiting" || prev.phase === "responded") &&
          prev.invitation.expiresAt === expiresAt &&
          !(prev.phase === "responded" && (prev.approving || prev.approvalSent))
            ? { phase: "expired" }
            : prev
        );
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [expiresAt]);

  // Whether a phone has answered, every few seconds while the invitation is open.
  useEffect(() => {
    if (openId === null || approving) return;
    let active = true;
    let timer: number | undefined;
    const apply = (read: DecisionsPairingState) => {
      if (!active || currentId.current !== openId) return;
      if ("result" in read) {
        setPollProblem(describeRelayRequestFailure(read));
        return;
      }
      setPollProblem(null);
      if (read.state === "paired") {
        // An approval whose answer was lost: the relay has the phone now.
        currentId.current = null;
        setState({ phase: "paired", label: read.label });
        notifyPaired();
        return;
      }
      setState((prev) => {
        if (
          (prev.phase !== "waiting" && prev.phase !== "responded") ||
          prev.invitation.pairingId !== openId ||
          (prev.phase === "responded" && prev.approving)
        ) {
          return prev;
        }
        switch (read.state) {
          case "waiting":
            return prev.phase === "waiting"
              ? prev
              : { phase: "waiting", invitation: prev.invitation };
          case "responded":
            if (prev.phase === "responded" && prev.answer.code === read.code) return prev;
            return {
              phase: "responded",
              invitation: prev.invitation,
              answer: { code: read.code, label: read.label, role: read.role },
              approving: false,
              approvalSent: false,
              approveError: null,
            };
          case "expired":
          case "unknown":
            return { phase: "expired" };
        }
      });
    };
    const tick = () => {
      window.electron.decisions
        .getPairing(openId)
        .then(apply, (error: unknown) => {
          if (active) setPollProblem(formatErrorMessage(error, "Couldn't check with the relay."));
        })
        .then(() => {
          if (active) timer = window.setTimeout(tick, PAIRING_POLL_MS);
        });
    };
    timer = window.setTimeout(tick, PAIRING_POLL_MS);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [openId, approving]);

  const start = () => {
    if (state.phase === "starting" || open) return;
    currentId.current = null;
    const generation = ++startGeneration.current;
    setPollProblem(null);
    setState({ phase: "starting" });
    window.electron.decisions.startPairing().then(
      (result) => {
        if (generation !== startGeneration.current) {
          // Cancelled while the relay made it: nobody will scan it, so it goes.
          if (result.result === "started") {
            window.electron.decisions.declinePairing(result.invitation.pairingId).catch(() => {});
          }
          return;
        }
        if (result.result === "started") {
          currentId.current = result.invitation.pairingId;
          setNow(Date.now());
          setState({ phase: "waiting", invitation: result.invitation });
        } else {
          setState({ phase: "start-failed", message: startFailure(result) });
        }
      },
      (error: unknown) => {
        if (generation !== startGeneration.current) return;
        setState({
          phase: "start-failed",
          message: formatErrorMessage(error, "Couldn't make a pairing code."),
        });
      }
    );
  };

  const approve = () => {
    if (state.phase !== "responded" || state.approving) return;
    const { invitation, answer } = state;
    const pairingId = invitation.pairingId;
    setState({ ...state, approving: true, approvalSent: true, approveError: null });
    const keepAnswer = (approveError: string) =>
      setState((prev) =>
        prev.phase === "responded" && prev.invitation.pairingId === pairingId
          ? { ...prev, approving: false, approveError }
          : prev
      );
    window.electron.decisions.approvePairing({ pairingId, code: answer.code }).then(
      (result) => {
        // Closing the dialog doesn't take the approval back, so a pairing it
        // finishes after the close still reaches the device list.
        if (result.result === "paired") onPaired?.();
        if (currentId.current !== pairingId) return;
        switch (result.result) {
          case "paired":
            currentId.current = null;
            setState({ phase: "paired", label: result.label });
            return;
          case "expired":
            currentId.current = null;
            setState({ phase: "expired" });
            return;
          case "changed":
            currentId.current = null;
            setState({ phase: "changed" });
            return;
          case "full":
            keepAnswer(
              "Your relay already holds as many devices as it allows, so it can't take another."
            );
            return;
          default:
            // The approval may have reached the relay; the next check finds out.
            keepAnswer(
              `Couldn't confirm the approval. ${describeRelayRequestFailure(result)} Daintree keeps checking whether ${answer.label} was paired.`
            );
        }
      },
      (error: unknown) => {
        if (currentId.current === pairingId) {
          keepAnswer(
            `Couldn't confirm the approval. ${formatErrorMessage(error, "Try again in a moment.")}`
          );
        }
      }
    );
  };

  const decline = () => {
    // Once an approval was sent, "declined" could be untrue: the relay may have taken it.
    if (state.phase !== "responded" || state.approving || state.approvalSent) return;
    const pairingId = state.invitation.pairingId;
    currentId.current = null;
    setState({ phase: "declined" });
    // Main forgets the invitation before asking the relay, so this computer
    // can't approve it whatever the relay answers; it lapses there regardless.
    window.electron.decisions.declinePairing(pairingId).catch(() => {});
  };

  const cancel = () => {
    // An approval already sent is left to finish: declining now would race it.
    const sent = state.phase === "responded" && state.approvalSent;
    const pairingId = open && !sent ? open.pairingId : null;
    startGeneration.current++;
    currentId.current = null;
    setPollProblem(null);
    setState({ phase: "idle" });
    if (pairingId !== null) window.electron.decisions.declinePairing(pairingId).catch(() => {});
  };

  return { state, pollProblem, now, start, approve, decline, cancel };
}
