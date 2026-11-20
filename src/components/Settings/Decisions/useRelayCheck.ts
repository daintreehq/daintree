import { useEffect, useRef, useState } from "react";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import type { DecisionsRelayCheck } from "@shared/types/decisions";

/**
 * Who started a check: the person (Check, a setup, an update ending) or
 * Settings by itself when it opens on a connected relay. A background check
 * shows only what's wrong, so opening the page doesn't add rows to it.
 */
export type RelayCheckSource = "requested" | "background";

export interface UseRelayCheckResult {
  /** The last observation, for the URL in `checkedUrl`. */
  check: DecisionsRelayCheck | null;
  /** What was typed for that observation, so an edit can tell it no longer applies. */
  checkedUrl: string | null;
  /**
   * Who asked for what `check` or `error` shows. A background check of a URL
   * the person already asked about stays `requested`, so its rows don't drop out.
   */
  source: RelayCheckSource | null;
  checking: boolean;
  /** Who asked for the check in flight; null when none is. */
  checkingSource: RelayCheckSource | null;
  /** The check itself couldn't run (main refused or failed); not something the relay did. */
  error: string | null;
  run(url: string, source?: RelayCheckSource): void;
  /** Forgets the last observation and drops any check still in flight. */
  reset(): void;
}

/**
 * One relay check at a time, asked of main (#16005), which makes the
 * requests. A newer run, a reset or unmounting drops a reply still on its way,
 * so a slow relay can't overwrite what the section now shows; a background
 * run never drops one the person asked for of the same URL. Promise chains
 * rather than try/finally, which the React Compiler can't lower.
 */
export function useRelayCheck(): UseRelayCheckResult {
  const [check, setCheck] = useState<DecisionsRelayCheck | null>(null);
  const [checkedUrl, setCheckedUrl] = useState<string | null>(null);
  const [source, setSource] = useState<RelayCheckSource | null>(null);
  const [checkingSource, setCheckingSource] = useState<RelayCheckSource | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const inFlight = useRef<{ url: string; source: RelayCheckSource } | null>(null);
  const settled = useRef<{ url: string; source: RelayCheckSource } | null>(null);

  useEffect(
    () => () => {
      generation.current += 1;
    },
    []
  );

  const run = (url: string, requested: RelayCheckSource = "requested") => {
    if (
      requested === "background" &&
      inFlight.current?.source === "requested" &&
      inFlight.current.url === url
    ) {
      return;
    }
    const mine = ++generation.current;
    inFlight.current = { url, source: requested };
    setCheckingSource(requested);
    // A background retry leaves the failure the person saw until it has an answer of its own.
    if (requested === "requested") setError(null);
    const settle = () => {
      inFlight.current = null;
      const shown: RelayCheckSource =
        requested === "requested" ||
        (settled.current?.source === "requested" && settled.current.url === url)
          ? "requested"
          : "background";
      settled.current = { url, source: shown };
      setSource(shown);
      setCheckingSource(null);
    };
    // Both outcomes are handled here, so nothing is left to reject unseen.
    window.electron.decisions.checkRelay(url).then(
      (next) => {
        if (generation.current !== mine) return;
        settle();
        setCheck(next);
        setCheckedUrl(url);
        setError(null);
      },
      (failure: unknown) => {
        if (generation.current !== mine) return;
        settle();
        setCheck(null);
        setCheckedUrl(null);
        setError(formatErrorMessage(failure, "The relay couldn't be checked."));
      }
    );
  };

  const reset = () => {
    generation.current += 1;
    inFlight.current = null;
    settled.current = null;
    setCheck(null);
    setCheckedUrl(null);
    setSource(null);
    setCheckingSource(null);
    setError(null);
  };

  return {
    check,
    checkedUrl,
    source,
    checking: checkingSource !== null,
    checkingSource,
    error,
    run,
    reset,
  };
}
