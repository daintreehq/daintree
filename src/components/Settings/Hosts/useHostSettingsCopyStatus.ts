import { useCallback, useEffect, useRef, useState } from "react";
import type { SettingsCopyStatus } from "@shared/types/ipc/settingsCopy";
import type { HostId } from "@shared/types/remoteHosts";
import { clientErrorText } from "@/utils/clientAppError";

export type HostSettingsCopyStatusState =
  | { kind: "idle" }
  | { kind: "loading"; previous: SettingsCopyStatus | null }
  | { kind: "ready"; status: SettingsCopyStatus }
  /** `previous` is what the last answer said, kept so a failed refresh doesn't hide it. */
  | { kind: "error"; message: string; previous: SettingsCopyStatus | null };

/** The last status the page was given, whatever is happening now. */
export function statusOf(state: HostSettingsCopyStatusState): SettingsCopyStatus | null {
  if (state.kind === "ready") return state.status;
  if (state.kind === "loading" || state.kind === "error") return state.previous;
  return null;
}

/**
 * What a copy to the host would change, and the last copy it received
 * (#13347). Asked for when the page opens and on Refresh, never on a timer;
 * an answer for a host or request since replaced is dropped.
 */
export function useHostSettingsCopyStatus(hostId: HostId, hostName: string, connected: boolean) {
  const [state, setState] = useState<HostSettingsCopyStatusState>({ kind: "idle" });
  const generation = useRef(0);

  const refresh = useCallback(() => {
    if (!connected) return;
    const ticket = ++generation.current;
    setState((prev) => ({ kind: "loading", previous: statusOf(prev) }));
    window.electron.settingsCopy.status({ hostId }).then(
      (status) => {
        if (generation.current !== ticket) return;
        setState({ kind: "ready", status });
      },
      (err: unknown) => {
        if (generation.current !== ticket) return;
        setState((prev) => ({
          kind: "error",
          message: clientErrorText(err, `Couldn't compare settings with ${hostName}`),
          previous: statusOf(prev),
        }));
      }
    );
  }, [hostId, hostName, connected]);

  /** Show a status the page already has, such as an undo's own answer. */
  const show = useCallback((status: SettingsCopyStatus) => {
    generation.current += 1;
    setState({ kind: "ready", status });
  }, []);

  useEffect(() => {
    generation.current += 1;
    setState({ kind: "idle" });
    if (connected) refresh();
  }, [hostId, connected, refresh]);

  useEffect(
    () => () => {
      generation.current += 1;
    },
    []
  );

  return { state, refresh, show };
}
