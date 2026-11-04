import { useEffect, useRef, useState } from "react";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import type { DecisionsPolicy } from "@shared/types/decisions";

export interface DecisionsPolicySaveFailure {
  allowed: boolean;
  message: string;
}

export interface DecisionsExpirySaveFailure {
  ms: number | null;
  message: string;
}

export interface DecisionsAgentSaveFailure {
  agentId: string;
  enabled: boolean;
  message: string;
}

export interface UseDecisionsPolicyResult {
  /** Null until main has answered, and while Decisions is off. */
  policy: DecisionsPolicy | null;
  loadError: string | null;
  /** The allowlist value being saved, so the switch shows what was asked while main acts. */
  pending: boolean | null;
  saveFailure: DecisionsPolicySaveFailure | null;
  /** The default expiry being saved, boxed because null is "never"; null when nothing is saving. */
  pendingExpiry: { ms: number | null } | null;
  expirySaveFailure: DecisionsExpirySaveFailure | null;
  /** Each agent's `ask_human` switch being saved, by agent id, so its row shows what was asked while main acts. */
  pendingAgents: Readonly<Record<string, boolean>>;
  agentSaveFailure: DecisionsAgentSaveFailure | null;
  reload(): Promise<void>;
  setProxyAllowlisted(allowed: boolean): Promise<void>;
  setDefaultQuestionExpiry(ms: number | null): Promise<void>;
  setAgentAskHuman(agentId: string, enabled: boolean): Promise<void>;
}

const READ_FAILED = "Decisions' policy couldn't be read.";

/**
 * The policy as main applies it, read while `active` (Decisions on): on
 * mount, again after every status push (main sends one with each policy
 * change, so another window's change shows here too), and answered by each
 * change asked here. Whichever answer carries the higher revision wins, so a
 * read that lands after a newer change can't roll the switch back. Turning
 * off forgets what was read, and anything still in flight from before lands
 * nowhere, so turning on again starts from main's answer, never a stale one.
 * Each field saves on its own, and each agent's `ask_human` switch too, so
 * changing one never waits on, or resends, another; main applies them in turn
 * over the setting as it stands.
 * Promise chains rather than try/finally, which the React Compiler can't lower.
 */
export function useDecisionsPolicy(active: boolean): UseDecisionsPolicyResult {
  const [policy, setPolicy] = useState<DecisionsPolicy | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pending, setPending] = useState<boolean | null>(null);
  const [saveFailure, setSaveFailure] = useState<DecisionsPolicySaveFailure | null>(null);
  const [pendingExpiry, setPendingExpiry] = useState<{ ms: number | null } | null>(null);
  const [expirySaveFailure, setExpirySaveFailure] = useState<DecisionsExpirySaveFailure | null>(
    null
  );
  const [pendingAgents, setPendingAgents] = useState<Readonly<Record<string, boolean>>>({});
  const [agentSaveFailure, setAgentSaveFailure] = useState<DecisionsAgentSaveFailure | null>(null);
  const savingRef = useRef(false);
  const savingExpiryRef = useRef(false);
  const savingAgentsRef = useRef(new Set<string>());
  const revisionRef = useRef(-1);
  /** Moves on each turn on and off; an answer asked for in another one is dropped. */
  const generationRef = useRef(0);

  /** Shows `next` unless something newer is already shown, or it was asked for before a turn off. */
  const accept = (next: DecisionsPolicy, generation: number): void => {
    if (generation !== generationRef.current || next.revision < revisionRef.current) return;
    revisionRef.current = next.revision;
    setPolicy(next);
    setLoadError(null);
  };

  const read = (): Promise<void> => {
    const generation = generationRef.current;
    return window.electron.decisions.getPolicy().then(
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
    const show = (next: DecisionsPolicy) => {
      if (generation !== generationRef.current || next.revision < revisionRef.current) return;
      revisionRef.current = next.revision;
      setPolicy(next);
      setLoadError(null);
    };
    const fetchPolicy = () =>
      window.electron.decisions.getPolicy().then(show, (error: unknown) => {
        if (generation === generationRef.current) {
          setLoadError(formatErrorMessage(error, READ_FAILED));
        }
      });
    // Subscribed before the read, so a change between the two is never missed.
    const off = window.electron.events.on("decisions:status-changed", () => void fetchPolicy());
    void fetchPolicy();
    return () => {
      generationRef.current += 1;
      off();
      revisionRef.current = -1;
      setPolicy(null);
      setLoadError(null);
      setSaveFailure(null);
      setExpirySaveFailure(null);
      setAgentSaveFailure(null);
    };
  }, [active]);

  const reload = (): Promise<void> => {
    setLoadError(null);
    return read();
  };

  const setProxyAllowlisted = (allowed: boolean): Promise<void> => {
    if (savingRef.current) return Promise.resolve();
    savingRef.current = true;
    setPending(allowed);
    setSaveFailure(null);
    const generation = generationRef.current;
    return window.electron.decisions
      .setProxyAllowlisted(allowed)
      .then(
        (next) => accept(next, generation),
        (error: unknown) => {
          if (generation !== generationRef.current) return;
          setSaveFailure({ allowed, message: formatErrorMessage(error, "Try again in a moment.") });
          // Show what main holds now rather than what was asked.
          void read();
        }
      )
      .then(() => {
        savingRef.current = false;
        setPending(null);
      });
  };

  const setDefaultQuestionExpiry = (ms: number | null): Promise<void> => {
    if (savingExpiryRef.current) return Promise.resolve();
    savingExpiryRef.current = true;
    setPendingExpiry({ ms });
    setExpirySaveFailure(null);
    const generation = generationRef.current;
    return window.electron.decisions
      .setDefaultQuestionExpiry(ms)
      .then(
        (next) => accept(next, generation),
        (error: unknown) => {
          if (generation !== generationRef.current) return;
          setExpirySaveFailure({
            ms,
            message: formatErrorMessage(error, "Try again in a moment."),
          });
          void read();
        }
      )
      .then(() => {
        savingExpiryRef.current = false;
        setPendingExpiry(null);
      });
  };

  const setAgentAskHuman = (agentId: string, enabled: boolean): Promise<void> => {
    if (savingAgentsRef.current.has(agentId)) return Promise.resolve();
    savingAgentsRef.current.add(agentId);
    setPendingAgents((current) => ({ ...current, [agentId]: enabled }));
    setAgentSaveFailure(null);
    const generation = generationRef.current;
    return window.electron.decisions
      .setAgentAskHuman({ agentId, enabled })
      .then(
        (next) => accept(next, generation),
        (error: unknown) => {
          if (generation !== generationRef.current) return;
          setAgentSaveFailure({
            agentId,
            enabled,
            message: formatErrorMessage(error, "Try again in a moment."),
          });
          void read();
        }
      )
      .then(() => {
        savingAgentsRef.current.delete(agentId);
        setPendingAgents((current) => {
          const next = { ...current };
          delete next[agentId];
          return next;
        });
      });
  };

  return {
    policy: active ? policy : null,
    loadError: active ? loadError : null,
    pending,
    saveFailure: active ? saveFailure : null,
    pendingExpiry,
    expirySaveFailure: active ? expirySaveFailure : null,
    pendingAgents,
    agentSaveFailure: active ? agentSaveFailure : null,
    reload,
    setProxyAllowlisted,
    setDefaultQuestionExpiry,
    setAgentAskHuman,
  };
}
