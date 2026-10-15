import { useCallback, useEffect, useRef, useState } from "react";
import type { SettingsCopyStatus } from "@shared/types/ipc/settingsCopy";
import type { HostId } from "@shared/types/remoteHosts";
import { clientErrorText } from "@/utils/clientAppError";

export type HostSettingsCopyStatusState =
  | { kind: "idle" }
  | { kind: "loading"; previous: SettingsCopyStatus | null }
  | { kind: "ready"; status: SettingsCopyStatus }
  | { kind: "error"; message: string };

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
    setState((prev) => ({
      kind: "loading",
      previous:
        prev.kind === "ready" ? prev.status : prev.kind === "loading" ? prev.previous : null,
    }));
    window.electron.settingsCopy.status({ hostId }).then(
      (status) => {
        if (generation.current !== ticket) return;
        setState({ kind: "ready", status });
      },
      (err: unknown) => {
        if (generation.current !== ticket) return;
        setState({
          kind: "error",
          message: clientErrorText(err, `Couldn't check settings on ${hostName}`),
        });
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
