import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/Callout";
import { remoteHostsClient } from "@/clients/remoteHostsClient";
import type { HostConnectionState, HostId } from "@shared/types/remoteHosts";
import { clientErrorText } from "@/utils/clientAppError";
import { connectionLabel } from "./hostLabels";

/**
 * Why a picked host's work settings can't be changed right now, above the
 * page so it stays in view while the page scrolls: what its link reports and
 * the one step that moves it on. Nothing while it is connected and answering.
 */
export function HostLinkStatus({
  hostId,
  hostName,
  connection,
  hasReading,
  onOpenHost,
}: {
  hostId: HostId;
  hostName: string;
  connection: HostConnectionState;
  /** A reading from before the link dropped is still shown under this. */
  hasReading: boolean;
  /** Settings → Hosts → this host, where builds and Host mode are dealt with. */
  onOpenHost: () => void;
}) {
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);

  if (connection.status === "connected" && connection.quietSince === undefined) return null;

  const connect = () => {
    setConnecting(true);
    setConnectError(null);
    remoteHostsClient.connectAndSettle(hostId, { restart: true }).then(
      (state) => {
        setConnecting(false);
        if (state.status === "unreachable" && !state.hostModeOff) {
          setConnectError(`Couldn't connect: ${state.detail ?? "the host didn't answer"}`);
        }
      },
      (err: unknown) => {
        setConnecting(false);
        setConnectError(`Couldn't connect: ${clientErrorText(err, "unknown error")}`);
      }
    );
  };

  const trying =
    connecting ||
    connection.status === "connecting" ||
    (connection.status === "unreachable" && connection.restarting === true);
  const needsHost =
    connection.status === "version-mismatch" ||
    (connection.status === "unreachable" && connection.hostModeOff === true);

  const title =
    connection.status === "connected"
      ? `${hostName} isn't answering`
      : trying
        ? `Connecting to ${hostName}`
        : `${hostName} isn't connected`;
  const consequence =
    connection.status === "connected"
      ? "Changes may not reach it until it answers again."
      : hasReading
        ? "Its settings are shown as last read and can't be changed until it's back."
        : "Its settings are read once it connects.";

  const action =
    connection.status === "connected" ? undefined : needsHost ? (
      <Button variant="outline" size="sm" onClick={onOpenHost}>
        Open host
      </Button>
    ) : connection.status === "driven-elsewhere" ? undefined : (
      // `loading` vetoes a second press but keeps focus, unlike native disabled.
      <Button variant="outline" size="sm" onClick={connect} loading={trying}>
        {connection.status === "unreachable" || connectError ? "Retry" : "Connect"}
      </Button>
    );

  return (
    <Callout severity="neutral" role="status" title={title} action={action}>
      <p className="select-text">
        {connectionLabel(connection)}. {consequence}
      </p>
      {connectError && <p className="mt-1 text-text-primary select-text">{connectError}</p>}
    </Callout>
  );
}
