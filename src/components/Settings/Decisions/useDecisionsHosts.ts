import { useEffect, useState } from "react";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import type { DecisionsHost } from "@shared/types/decisionsHosts";
import { hostsUnlistedText } from "./hostsCopy";

export interface UseDecisionsHostsResult {
  /** The Hosts as main last showed them; null until a read lists them. */
  hosts: DecisionsHost[] | null;
  /** Automatic enrollment as saved, or as being saved. */
  autoEnroll: boolean;
  /** Why the latest read didn't list them; null once one does. */
  loadError: string | null;
  /** The switch is being saved. */
  savingAuto: boolean;
  /** Why the last change of the switch or the last Enroll didn't go through, and how to try it again. */
  actionFailure: { message: string; retry: () => void } | null;
  /** Hosts whose Enroll is in flight from this window. */
  enrolling: ReadonlySet<string>;
  setAutoEnroll(enabled: boolean): void;
  enroll(hostId: string): void;
  reload(): void;
}

/**
 * The Remote Hosts this computer enrolls as Decisions devices (#16021), read
 * from main when the section mounts and again with every status push
 * (`revision`), since an enrollment's progress rides on it. Listing asks no
 * Host and no relay. `enabled` false (no relay set up) reads nothing. Only
 * the last read asked for lands. Changes use promise chains rather than
 * try/finally, which the React Compiler can't lower.
 */
export function useDecisionsHosts(enabled: boolean, revision: number): UseDecisionsHostsResult {
  const [hosts, setHosts] = useState<DecisionsHost[] | null>(null);
  const [autoEnroll, setAutoEnrollShown] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [savingAuto, setSavingAuto] = useState(false);
  const [actionFailure, setActionFailure] = useState<{ message: string; retry: () => void } | null>(
    null
  );
  const [enrolling, setEnrolling] = useState<ReadonlySet<string>>(new Set());
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    if (!enabled) {
      setHosts(null);
      setLoadError(null);
      return;
    }
    let current = true;
    window.electron.decisions.listHosts().then(
      (read) => {
        if (!current) return;
        if (read.result === "listed") {
          setHosts(read.hosts);
          setAutoEnrollShown(read.autoEnroll);
          setLoadError(null);
        } else {
          // No owner to enroll with now: rows that offered Enroll would do nothing.
          setHosts(null);
          setLoadError(hostsUnlistedText(read));
        }
      },
      (error: unknown) => {
        if (current) setLoadError(formatErrorMessage(error, "The Remote Hosts couldn't be read."));
      }
    );
    return () => {
      current = false;
    };
  }, [enabled, revision, generation]);

  const reread = () => setGeneration((n) => n + 1);

  const setAutoEnroll = (next: boolean) => {
    if (savingAuto) return;
    setSavingAuto(true);
    setActionFailure(null);
    void window.electron.decisions
      .setAutoEnrollHosts(next)
      .then(
        (read) => {
          if (read.result === "listed") {
            setHosts(read.hosts);
            setAutoEnrollShown(read.autoEnroll);
          }
        },
        (error: unknown) =>
          setActionFailure({
            message: formatErrorMessage(
              error,
              next
                ? "Automatic enrollment couldn't be turned on."
                : "Automatic enrollment couldn't be turned off."
            ),
            retry: () => setAutoEnroll(next),
          })
      )
      .then(() => setSavingAuto(false));
  };

  const enroll = (hostId: string) => {
    if (enrolling.has(hostId)) return;
    setEnrolling((held) => new Set(held).add(hostId));
    setActionFailure(null);
    const retry = () => enroll(hostId);
    void window.electron.decisions
      .enrollHost({ hostId })
      .then(
        (outcome) => {
          if (outcome.result === "not-connected") {
            setActionFailure({
              message: "That Host isn't connected now. Connect to it, then enroll it.",
              retry,
            });
          } else if (outcome.result === "not-set-up") {
            setActionFailure({
              message: "No relay is set up on this computer. Connect one above first.",
              retry,
            });
          }
        },
        (error: unknown) =>
          setActionFailure({
            message: formatErrorMessage(error, "The Host couldn't be enrolled."),
            retry,
          })
      )
      .then(() => {
        setEnrolling((held) => {
          const next = new Set(held);
          next.delete(hostId);
          return next;
        });
        reread();
      });
  };

  return {
    hosts,
    autoEnroll,
    loadError,
    savingAuto,
    actionFailure,
    enrolling,
    setAutoEnroll,
    enroll,
    reload: reread,
  };
}
