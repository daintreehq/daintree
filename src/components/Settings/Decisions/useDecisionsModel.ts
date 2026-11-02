import { useEffect, useRef, useState } from "react";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import type {
  DecisionsModelState,
  SetDecisionsModelPayload,
} from "@shared/types/decisionsModel";

/** What was asked of main, so the failure that comes back says which. */
export type DecisionsModelAction = "learning" | "adapter" | "evaluate" | "cancel" | "threshold" | "clear";

export interface DecisionsModelFailure {
  action: DecisionsModelAction;
  message: string;
  /** The preferences asked for, so Retry asks for them again. */
  payload?: SetDecisionsModelPayload;
}

export interface UseDecisionsModelResult {
  /** Null until main has answered, and while Decisions is off. */
  model: DecisionsModelState | null;
  loadError: string | null;
  /** What main is acting on now; nothing else starts meanwhile. */
  pending: DecisionsModelAction | null;
  /** The preferences being saved, so the switch and the CLI show what was asked. */
  pendingPreferences: SetDecisionsModelPayload | null;
  failure: DecisionsModelFailure | null;
  reload(): Promise<void>;
  setPreferences(payload: SetDecisionsModelPayload, action: "learning" | "adapter"): Promise<void>;
  startEvaluation(): Promise<void>;
  cancelEvaluation(runId: string): Promise<void>;
  setThreshold(threshold: number | null, evaluatedAt: number): Promise<void>;
  /** Resolves true once main has cleared the history. */
  clearHistory(): Promise<boolean>;
}

const READ_FAILED = "The decision model's settings couldn't be read.";

/**
 * The decision model as main observes it, read while `active` (Decisions
 * on): on mount, again after every status push (main sends one with each
 * change to the model, so an evaluation finishing, another window's change
 * and a newly learned answer all show), and answered by each change asked
 * here. The higher revision wins, so a read that lands after a newer answer
 * can't roll it back. Turning off forgets what was read, and anything still
 * in flight from before lands nowhere. Unmounting cancels nothing in main: an
 * evaluation goes on and the next mount reads it.
 */
export function useDecisionsModel(active: boolean): UseDecisionsModelResult {
  const [model, setModel] = useState<DecisionsModelState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pending, setPending] = useState<DecisionsModelAction | null>(null);
  const [pendingPreferences, setPendingPreferences] = useState<SetDecisionsModelPayload | null>(
    null
  );
  const [failure, setFailure] = useState<DecisionsModelFailure | null>(null);
  const busyRef = useRef(false);
  const revisionRef = useRef(-1);
  /** Moves on each turn on and off; an answer asked for in another one is dropped. */
  const generationRef = useRef(0);

  const accept = (next: DecisionsModelState, generation: number): void => {
    if (generation !== generationRef.current || next.revision < revisionRef.current) return;
    revisionRef.current = next.revision;
    setModel(next);
    setLoadError(null);
  };

  const read = (): Promise<void> => {
    const generation = generationRef.current;
    return window.electron.decisions.getModel().then(
      (next) => accept(next, generation),
      (error: unknown) => {
        if (generation === generationRef.current) {
          setLoadError(formatErrorMessage(error, READ_FAILED));
        }
      }
    );
  };

  useEffect(() => {
    if (!active) return;
    const generation = ++generationRef.current;
    const show = (next: DecisionsModelState) => {
      if (generation !== generationRef.current || next.revision < revisionRef.current) return;
      revisionRef.current = next.revision;
      setModel(next);
      setLoadError(null);
    };
    const fetchModel = () =>
      window.electron.decisions.getModel().then(show, (error: unknown) => {
        if (generation === generationRef.current) {
          setLoadError(formatErrorMessage(error, READ_FAILED));
        }
      });
    // Subscribed before the read, so a change between the two is never missed.
    const off = window.electron.events.on("decisions:status-changed", () => void fetchModel());
    void fetchModel();
    return () => {
      generationRef.current += 1;
      off();
      revisionRef.current = -1;
      setModel(null);
      setLoadError(null);
      setFailure(null);
    };
  }, [active]);

  /** Runs one change at a time; a failure says which it was and shows what main holds now. */
  const act = (
    action: DecisionsModelAction,
    call: () => Promise<DecisionsModelState>,
    payload?: SetDecisionsModelPayload
  ): Promise<boolean> => {
    if (busyRef.current) return Promise.resolve(false);
    busyRef.current = true;
    setPending(action);
    setPendingPreferences(payload ?? null);
    setFailure(null);
    const generation = generationRef.current;
    return call()
      .then(
        (next) => {
          accept(next, generation);
          return true;
        },
        (error: unknown) => {
          if (generation === generationRef.current) {
            setFailure({
              action,
              message: formatErrorMessage(error, "Try again in a moment."),
              ...(payload ? { payload } : {}),
            });
            void read();
          }
          return false;
        }
      )
      .then((done) => {
        busyRef.current = false;
        setPending(null);
        setPendingPreferences(null);
        return done;
      });
  };

  const reload = (): Promise<void> => {
    setLoadError(null);
    return read();
  };

  return {
    model: active ? model : null,
    loadError: active ? loadError : null,
    pending,
    pendingPreferences,
    failure: active ? failure : null,
    reload,
    setPreferences: (payload, action) =>
      act(action, () => window.electron.decisions.setModel(payload), payload).then(() => {}),
    startEvaluation: () =>
      act("evaluate", () => window.electron.decisions.startModelEvaluation()).then(() => {}),
    cancelEvaluation: (runId) =>
      act("cancel", () => window.electron.decisions.cancelModelEvaluation({ runId })).then(
        () => {}
      ),
    setThreshold: (threshold, evaluatedAt) =>
      act("threshold", () =>
        window.electron.decisions.setModelThreshold({ threshold, evaluatedAt })
      ).then(() => {}),
    clearHistory: () => act("clear", () => window.electron.decisions.clearModelHistory()),
  };
}
