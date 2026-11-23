import { useEffect, useRef, useState } from "react";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import type { DecisionsDevice } from "@shared/types/decisions";
import { describeRelayRequestFailure } from "./devicesCopy";

/** Coming back to the window re-reads the list, but not more often than this. */
const FOCUS_REREAD_MS = 15_000;

export interface UseDecisionsDevicesResult {
  /** What the relay last listed; null until a read succeeds. Kept while a later read runs or fails. */
  devices: DecisionsDevice[] | null;
  /** Why the latest read didn't list them, in words; null once one succeeds. */
  failure: string | null;
  loading: boolean;
  reload(): void;
}

/**
 * The devices paired with this computer's relay identity (#16009), read from
 * the relay through main when the section mounts, on `reload`, when main says
 * the devices changed (#16010), and when the window regains focus (a phone
 * may have just turned on notifications).
 * `relayOrigin` null (no relay set up) reads nothing. Only the last read asked
 * for lands, and what was read of one relay is never shown for another.
 */
export function useDecisionsDevices(relayOrigin: string | null): UseDecisionsDevicesResult {
  const [listed, setListed] = useState<{ origin: string; devices: DecisionsDevice[] } | null>(null);
  const [failed, setFailed] = useState<{ origin: string; message: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [generation, setGeneration] = useState(0);
  const lastRead = useRef(0);
  const enabled = relayOrigin !== null;

  useEffect(() => {
    if (relayOrigin === null) {
      setListed(null);
      setFailed(null);
      setLoading(false);
      return;
    }
    let current = true;
    setLoading(true);
    lastRead.current = Date.now();
    window.electron.decisions.listDevices().then(
      (read) => {
        if (!current) return;
        if (read.result === "listed") {
          setListed({ origin: relayOrigin, devices: read.devices });
          setFailed(null);
        } else {
          setFailed({ origin: relayOrigin, message: describeRelayRequestFailure(read) });
        }
        setLoading(false);
      },
      (error: unknown) => {
        if (!current) return;
        setFailed({
          origin: relayOrigin,
          message: formatErrorMessage(error, "The paired devices couldn't be read."),
        });
        setLoading(false);
      }
    );
    return () => {
      current = false;
    };
  }, [relayOrigin, generation]);

  // A device revoked or a key rotated, here, in another window or as the
  // relay's ledger reports it (#16010): read the list again now.
  useEffect(() => {
    if (!enabled) return;
    return window.electron.events.on("decisions:devices-changed", () => {
      setGeneration((n) => n + 1);
    });
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    const onFocus = () => {
      if (Date.now() - lastRead.current >= FOCUS_REREAD_MS) setGeneration((n) => n + 1);
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [enabled]);

  return {
    devices: listed !== null && listed.origin === relayOrigin ? listed.devices : null,
    failure: failed !== null && failed.origin === relayOrigin ? failed.message : null,
    loading,
    reload: () => setGeneration((n) => n + 1),
  };
}
