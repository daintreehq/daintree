import { useEffect, useRef, useState } from "react";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import type { DecisionsRelayCheck } from "@shared/types/decisions";

export interface UseRelayCheckResult {
  /** The last observation, for the URL in `checkedUrl`. */
  check: DecisionsRelayCheck | null;
  /** What was typed for that observation, so an edit can tell it no longer applies. */
  checkedUrl: string | null;
  checking: boolean;
  /** The check itself couldn't run (main refused or failed); not something the relay did. */
  error: string | null;
  run(url: string): void;
  /** Forgets the last observation and drops any check still in flight. */
  reset(): void;
}

/**
 * One relay check at a time, asked of main (#16005), which makes the
 * requests. A newer run, a reset or unmounting drops a reply still on its way,
 * so a slow relay can't overwrite what the section now shows. Promise chains
 * rather than try/finally, which the React Compiler can't lower.
 */
export function useRelayCheck(): UseRelayCheckResult {
  const [check, setCheck] = useState<DecisionsRelayCheck | null>(null);
  const [checkedUrl, setCheckedUrl] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);

  useEffect(
    () => () => {
      generation.current += 1;
    },
    []
  );

  const run = (url: string) => {
    const mine = ++generation.current;
    setChecking(true);
    setError(null);
    void window.electron.decisions.checkRelay(url).then(
      (next) => {
        if (generation.current !== mine) return;
        setCheck(next);
        setCheckedUrl(url);
        setChecking(false);
      },
      (failure: unknown) => {
        if (generation.current !== mine) return;
        setCheck(null);
        setCheckedUrl(null);
        setError(formatErrorMessage(failure, "The relay couldn't be checked."));
        setChecking(false);
      }
    );
  };

  const reset = () => {
    generation.current += 1;
    setCheck(null);
    setCheckedUrl(null);
    setChecking(false);
    setError(null);
  };

  return { check, checkedUrl, checking, error, run, reset };
}
