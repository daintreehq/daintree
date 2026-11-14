import { useState, type ReactNode } from "react";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { InlineError } from "@/components/ui/field";
import { cloudHostsClient } from "@/clients/cloudHostsClient";
import { clientErrorText, isClientAppError } from "@/utils/clientAppError";
import type { CloudHostStatus } from "@shared/types/cloudHosts";
import type { HostId } from "@shared/types/remoteHosts";
import { cloudStatusFor, useCloudHosts } from "./cloudHostsState";

function errorText(err: unknown, fallback: string): string {
  return isClientAppError(err) && err.userMessage
    ? err.userMessage
    : clientErrorText(err, fallback);
}

function hourlyClause(status: CloudHostStatus): string {
  return status.hourlyDollars !== null
    ? `about $${status.hourlyDollars.toFixed(3)} an hour`
    : "for the time it runs";
}

function lifetimeClause(status: CloudHostStatus): string {
  if (status.lifetimeSeconds === null) return "It runs until you stop it.";
  const hours = Math.round(status.lifetimeSeconds / 3600);
  return `It stops by itself after ${hours === 1 ? "1 hour" : `${hours} hours`}, later while it's in use here, or when you stop it.`;
}

interface StartRequest {
  hostId: HostId;
  name: string;
  /** Runs once the machine is up: open the host. Skipped when `stale()` says a newer pick won. */
  then?: () => void;
  stale?: () => boolean;
}

/**
 * Start and Stop for cloud machines, shared by the host menu, Settings and a
 * host's details. Start runs at once from an explicit Start control; one asked
 * for by opening a stopped host first says what it costs, from the machine's
 * status as it is now. Stop always confirms, since whatever runs on the machine
 * ends with it. Both dialogs stay open until the provider answered, and say
 * why when it refused.
 */
export function useCloudMachineActions(): {
  start(hostId: HostId): void;
  confirmStart(request: StartRequest): void;
  requestStop(hostId: HostId, name: string): void;
  isPending(hostId: HostId): boolean;
  errorFor(hostId: HostId): string | null;
  dialogs: ReactNode;
} {
  const { snapshot } = useCloudHosts();
  const [pending, setPending] = useState<ReadonlySet<HostId>>(new Set());
  const [errors, setErrors] = useState<Readonly<Record<HostId, string>>>({});
  const [stopAsk, setStopAsk] = useState<{ hostId: HostId; name: string } | null>(null);
  const [startAsk, setStartAsk] = useState<StartRequest | null>(null);

  const mark = (hostId: HostId, on: boolean) =>
    setPending((current) => {
      const next = new Set(current);
      if (on) next.add(hostId);
      else next.delete(hostId);
      return next;
    });
  const setError = (hostId: HostId, message: string | null) =>
    setErrors((current) => {
      const next = { ...current };
      if (message === null) delete next[hostId];
      else next[hostId] = message;
      return next;
    });

  const run = (
    hostId: HostId,
    work: () => Promise<void>,
    fallback: string,
    done?: () => void
  ): void => {
    mark(hostId, true);
    setError(hostId, null);
    work().then(
      () => {
        mark(hostId, false);
        done?.();
      },
      (err: unknown) => {
        mark(hostId, false);
        setError(hostId, errorText(err, fallback));
      }
    );
  };

  const start = (hostId: HostId) =>
    run(hostId, () => cloudHostsClient.startHost(hostId), "Couldn't start the machine");

  const startStatus = startAsk ? cloudStatusFor(snapshot, startAsk.hostId) : null;
  const stopBusy = stopAsk !== null && pending.has(stopAsk.hostId);
  const startBusy = startAsk !== null && pending.has(startAsk.hostId);

  const dialogs = (
    <>
      <ConfirmDialog
        isOpen={stopAsk !== null}
        onClose={() => {
          if (!stopBusy) setStopAsk(null);
        }}
        variant="destructive"
        title={`Stop '${stopAsk?.name ?? "machine"}'?`}
        description="Its disk is saved and billing for the machine stops. Terminals, agents and anything else running on it end; files on disk are kept, and it comes back when you start it."
        confirmLabel="Stop machine"
        isConfirmLoading={stopBusy}
        onConfirm={() => {
          const ask = stopAsk;
          if (!ask) return;
          run(
            ask.hostId,
            () => cloudHostsClient.stopHost(ask.hostId),
            "Couldn't stop the machine",
            () => setStopAsk(null)
          );
        }}
      >
        {stopAsk && errors[stopAsk.hostId] && (
          <InlineError role="alert">{errors[stopAsk.hostId]}</InlineError>
        )}
      </ConfirmDialog>
      <ConfirmDialog
        isOpen={startAsk !== null}
        onClose={() => {
          if (!startBusy) setStartAsk(null);
        }}
        variant="default"
        title={`Start '${startAsk?.name ?? "machine"}'?`}
        description={
          startStatus
            ? `Its machine isn't running. Starting it bills ${startStatus.accountName} ${hourlyClause(startStatus)} while it runs. ${lifetimeClause(startStatus)}`
            : "Reading the machine's state…"
        }
        confirmLabel="Start machine"
        confirmDisabled={startStatus === null}
        isConfirmLoading={startBusy}
        onConfirm={() => {
          const ask = startAsk;
          if (!ask) return;
          run(
            ask.hostId,
            () => cloudHostsClient.startHost(ask.hostId),
            "Couldn't start the machine",
            () => {
              setStartAsk(null);
              if (!ask.stale?.()) ask.then?.();
            }
          );
        }}
      >
        {startAsk && errors[startAsk.hostId] && (
          <InlineError role="alert">{errors[startAsk.hostId]}</InlineError>
        )}
      </ConfirmDialog>
    </>
  );

  return {
    start,
    confirmStart: (request) => {
      setError(request.hostId, null);
      setStartAsk(request);
    },
    requestStop: (hostId, name) => {
      setError(hostId, null);
      setStopAsk({ hostId, name });
    },
    isPending: (hostId) => pending.has(hostId),
    errorFor: (hostId) => errors[hostId] ?? null,
    dialogs,
  };
}
