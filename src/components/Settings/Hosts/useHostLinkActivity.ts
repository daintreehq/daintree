import { useCallback, useEffect, useRef, useState } from "react";
import type { HostLinkActivityResult } from "@shared/types/ipc/hostMetrics";
import type { HostId } from "@shared/types/remoteHosts";

export type HostLinkActivityState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; result: Extract<HostLinkActivityResult, { supported: true }> }
  | { kind: "unsupported" }
  | { kind: "error"; error: unknown };

/**
 * What a host reports about its links, read when the page opens or the link
 * comes back and again with each summary the host sends, so an away holder's
 * reservation reads as it runs out. No timer of its own: a tick that lands
 * while a read is out is skipped, and an answer for a host or link since
 * replaced is dropped. A host that can't report it isn't asked again until
 * it reconnects or the person retries.
 */
export function useHostLinkActivity(hostId: HostId, connected: boolean, sampledAt: number | null) {
  const [state, setState] = useState<HostLinkActivityState>({ kind: "idle" });
  const generation = useRef(0);
  const inFlight = useRef(false);
  const unsupported = useRef(false);

  const load = useCallback(() => {
    if (!connected || inFlight.current) return;
    inFlight.current = true;
    const ticket = generation.current;
    // What is already shown, an error included, stays while it is read again.
    setState((prev) =>
      prev.kind === "ready" || prev.kind === "error" ? prev : { kind: "loading" }
    );
    window.electron.hostMetrics.linkActivity({ hostId }).then(
      (result) => {
        if (generation.current !== ticket) return;
        inFlight.current = false;
        if (!result.supported) {
          unsupported.current = true;
          setState({ kind: "unsupported" });
          return;
        }
        setState({ kind: "ready", result });
      },
      (error: unknown) => {
        if (generation.current !== ticket) return;
        inFlight.current = false;
        setState({ kind: "error", error });
      }
    );
  }, [hostId, connected]);

  const refresh = useCallback(() => {
    unsupported.current = false;
    load();
  }, [load]);

  useEffect(() => {
    generation.current += 1;
    inFlight.current = false;
    unsupported.current = false;
    setState({ kind: "idle" });
    if (connected) load();
  }, [hostId, connected, load]);

  useEffect(() => {
    if (sampledAt !== null && !unsupported.current) load();
  }, [sampledAt, load]);

  useEffect(
    () => () => {
      generation.current += 1;
    },
    []
  );

  return { state, refresh };
}
