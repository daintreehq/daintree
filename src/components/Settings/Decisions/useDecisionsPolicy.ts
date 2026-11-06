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
  pendingAgents: ReadonlyMap<string, boolean>;
  /** Each agent's last failed save, by agent id, until that agent is saved again. */
  agentSaveFailures: ReadonlyMap<string, DecisionsAgentSaveFailure>;
  reload(): Promise<void>;
  setProxyAllowlisted(allowed: boolean): Promise<void>;
  setDefaultQuestionExpiry(ms: number | null): Promise<void>;
  setAgentAskHuman(agentId: string, enabled: boolean): Promise<void>;
}

const READ_FAILED = "Decisions' policy couldn't be read.";

const NO_AGENTS: ReadonlyMap<string, boolean> = new Map();
const NO_FAILURES: ReadonlyMap<string, DecisionsAgentSaveFailure> = new Map();

/** `map` without `key`, as a new map; the same one when it had no such key. */
function without<V>(map: ReadonlyMap<string, V>, key: string): ReadonlyMap<string, V> {
  if (!map.has(key)) return map;
  const next = new Map(map);
  next.delete(key);
  return next;
}

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
  // Maps, not objects: an agent id is any registry id, `toString` included.
  const [pendingAgents, setPendingAgents] = useState<ReadonlyMap<string, boolean>>(NO_AGENTS);
  const [agentSaveFailures, setAgentSaveFailures] =
    useState<ReadonlyMap<string, DecisionsAgentSaveFailure>>(NO_FAILURES);
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
      // A save still in flight lands nowhere now, so its row is free again
      // and turning on starts from main's answer alone.
      savingAgentsRef.current = new Set();
      setPendingAgents(NO_AGENTS);
      setAgentSaveFailures(NO_FAILURES);
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
    const saving = savingAgentsRef.current;
    if (saving.has(agentId)) return Promise.resolve();
    saving.add(agentId);
    setPendingAgents((current) => new Map(current).set(agentId, enabled));
    setAgentSaveFailures((current) => without(current, agentId));
    const generation = generationRef.current;
    return window.electron.decisions
      .setAgentAskHuman({ agentId, enabled })
      .then(
        (next) => accept(next, generation),
        (error: unknown) => {
          if (generation !== generationRef.current) return;
          const failure = {
            agentId,
            enabled,
            message: formatErrorMessage(error, "Try again in a moment."),
          };
          setAgentSaveFailures((current) => new Map(current).set(agentId, failure));
          void read();
        }
      )
      .then(() => {
        // A turn off meanwhile already let the row go, and a save asked for
        // since then is the one holding it now.
        if (generation !== generationRef.current) return;
        saving.delete(agentId);
        setPendingAgents((current) => without(current, agentId));
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
    agentSaveFailures: active ? agentSaveFailures : NO_FAILURES,
    reload,
    setProxyAllowlisted,
    setDefaultQuestionExpiry,
    setAgentAskHuman,
  };
}
