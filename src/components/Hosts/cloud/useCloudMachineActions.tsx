import { useState, type ReactNode } from "react";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { InlineError } from "@/components/ui/field";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { TimeAgo } from "@/components/ui/TimeAgo";
import { cloudHostsClient } from "@/clients/cloudHostsClient";
import { clientErrorText, isClientAppError } from "@/utils/clientAppError";
import type { CloudHostStatus } from "@shared/types/cloudHosts";
import type { HostId } from "@shared/types/remoteHosts";
import { cloudStatusFor, useCloudHosts } from "./cloudHostsState";
import { clockTime, isObservationStale, lifetimeSentence } from "./cloudHostLabels";

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

/** Why a machine that may be started now isn't running, from the reading it was asked on. */
function notRunningSentence(name: string, status: CloudHostStatus, askedAt: number): string {
  const word = status.machine === "error" ? "reported an error" : "stopped";
  if (!isObservationStale(status, askedAt)) {
    return status.machine === "error"
      ? `${name}'s machine reported an error.`
      : `${name}'s machine is stopped.`;
  }
  const at =
    status.observedAt !== null ? clockTime(new Date(status.observedAt).toISOString()) : null;
  return `${name}'s machine last reported ${word}${at ? `, ${at}` : ""}.`;
}

/**
 * A start or stop the provider accepted, while it runs: the step under way,
 * when it began, and that closing the dialog leaves it running.
 */
function OperationProgress({
  status,
  fallback,
}: {
  status: CloudHostStatus | null;
  fallback: string;
}) {
  const stage = status?.operation?.stage || fallback;
  // Boat keeps a machine whose save failed running while it retries, unbilled; it says so here.
  const retrying = status?.lastError?.code === "stop-failing" ? status.lastError.message : null;
  return (
    <div className="space-y-3" data-testid="cloud-operation-progress">
      <p className="text-sm font-medium text-text-primary" aria-live="polite">
        {stage}
      </p>
      <ProgressBar label="Machine progress" valueText={stage} />
      {retrying && <p className="text-xs text-text-secondary">{retrying}</p>}
      <p className="text-xs text-text-secondary">
        {status?.operation && (
          <>
            <TimeAgo prefix="Started " timestamp={status.operation.startedAt} />.{" "}
          </>
        )}
        Closing this doesn&apos;t stop it: the host&apos;s row in Settings → Hosts and the host menu
        follow it.
      </p>
    </div>
  );
}

interface StartRequest {
  hostId: HostId;
  name: string;
  /** When it was asked for, so the dialog judges the reading it was asked on. */
  askedAt?: number;
  /** Runs once the machine is up: open the host. Skipped when `stale()` says a newer pick won. */
  then?: () => void;
  stale?: () => boolean;
}

/**
 * Start and Stop for cloud machines, shared by the host menu, Settings and a
 * host's details. Start runs at once from an explicit Start control; one asked
 * for by opening a stopped host first says what it costs, from the machine's
 * status as it is now. Stop always confirms, since whatever runs on the machine
 * ends with it. Once confirmed, each dialog follows the work and can be closed
 * at any time without stopping it; a refusal shows in the dialog when it is
 * still open, and on the host's row and menu entry either way.
 */
export function useCloudMachineActions(): {
  start(hostId: HostId): void;
  /** Ask the provider again about a machine whose state is unknown or old. */
  check(hostId: HostId): void;
  confirmStart(request: StartRequest): void;
  requestStop(hostId: HostId, name: string): void;
  isPending(hostId: HostId): boolean;
  errorFor(hostId: HostId): string | null;
  dialogs: ReactNode;
} {
  const { snapshot } = useCloudHosts();
  const [pending, setPending] = useState<ReadonlySet<HostId>>(new Set());
  const [errors, setErrors] = useState<
    Readonly<Record<HostId, { message: string; at: number; read: boolean }>>
  >({});
  const [stopAsk, setStopAsk] = useState<{ hostId: HostId; name: string } | null>(null);
  const [startAsk, setStartAsk] = useState<StartRequest | null>(null);

  const mark = (hostId: HostId, on: boolean) =>
    setPending((current) => {
      const next = new Set(current);
      if (on) next.add(hostId);
      else next.delete(hostId);
      return next;
    });
  const setError = (hostId: HostId, message: string | null, read = false) =>
    setErrors((current) => {
      const next = { ...current };
      if (message === null) delete next[hostId];
      else next[hostId] = { message, at: Date.now(), read };
      return next;
    });
  // A failed read yields to any newer good one; a refused start or stop stands until another try.
  const errorFor = (hostId: HostId): string | null => {
    const entry = errors[hostId];
    if (!entry) return null;
    const observedAt = cloudStatusFor(snapshot, hostId)?.observedAt ?? null;
    return entry.read && observedAt !== null && observedAt > entry.at ? null : entry.message;
  };

  const run = (
    hostId: HostId,
    work: () => Promise<void>,
    fallback: string,
    done?: () => void,
    read = false
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
        setError(hostId, errorText(err, fallback), read);
      }
    );
  };

  const start = (hostId: HostId) =>
    run(hostId, () => cloudHostsClient.startHost(hostId), "Couldn't start the machine");

  const check = (hostId: HostId) =>
    run(
      hostId,
      () => cloudHostsClient.refreshHost(hostId),
      "Couldn't ask about the machine",
      undefined,
      true
    );

  const startStatus = startAsk ? cloudStatusFor(snapshot, startAsk.hostId) : null;
  const stopStatus = stopAsk ? cloudStatusFor(snapshot, stopAsk.hostId) : null;
  const stopBusy = stopAsk !== null && pending.has(stopAsk.hostId);
  const startBusy = startAsk !== null && pending.has(startAsk.hostId);

  const dialogs = (
    <>
      <ConfirmDialog
        isOpen={stopAsk !== null}
        // Closing never cancels: the stop goes on, followed by the row and the menu.
        onClose={() => setStopAsk(null)}
        variant="destructive"
        title={
          stopBusy
            ? `Stopping '${stopAsk?.name ?? "machine"}'`
            : `Stop '${stopAsk?.name ?? "machine"}'?`
        }
        description={
          stopBusy
            ? undefined
            : "Terminals, agents and anything else running on it end, and billing for the machine stops. Files in its home folder are kept for when you start it again; /tmp, caches and memory aren't."
        }
        confirmLabel={stopBusy ? "Stopping…" : "Stop machine"}
        confirmDisabled={stopBusy}
        cancelLabel={stopBusy ? "Close" : "Cancel"}
        initialFocus="cancel"
        // The confirm press disables its own button: focus moves to Close rather than the page.
        focusResetKey={stopBusy ? "progress" : "ask"}
        onConfirm={() => {
          const ask = stopAsk;
          if (!ask) return;
          run(
            ask.hostId,
            () => cloudHostsClient.stopHost(ask.hostId),
            "Couldn't stop the machine",
            () => setStopAsk((current) => (current?.hostId === ask.hostId ? null : current))
          );
        }}
      >
        {stopBusy && (
          <OperationProgress status={stopStatus} fallback="Asking the provider to stop it" />
        )}
        {stopAsk && errorFor(stopAsk.hostId) && (
          <InlineError role="alert">{errorFor(stopAsk.hostId)}</InlineError>
        )}
      </ConfirmDialog>
      <ConfirmDialog
        isOpen={startAsk !== null}
        // Closing never cancels: the start goes on, and the host still opens once it's up.
        onClose={() => setStartAsk(null)}
        variant="default"
        title={
          startBusy
            ? `Starting '${startAsk?.name ?? "machine"}'`
            : `Start '${startAsk?.name ?? "machine"}'?`
        }
        description={
          startBusy
            ? undefined
            : startStatus && startAsk
              ? `${notRunningSentence(startAsk.name, startStatus, startAsk.askedAt ?? 0)} Starting it bills ${startStatus.accountName} ${hourlyClause(startStatus)} while it runs. ${lifetimeSentence(startStatus.lifetimeSeconds)}`
              : "Reading the machine's state…"
        }
        confirmLabel={startBusy ? "Starting…" : "Start machine"}
        confirmDisabled={startStatus === null || startBusy}
        cancelLabel={startBusy ? "Close" : "Cancel"}
        focusResetKey={startBusy ? "progress" : "ask"}
        initialFocus={startBusy ? "cancel" : undefined}
        onConfirm={() => {
          const ask = startAsk;
          if (!ask) return;
          run(
            ask.hostId,
            () => cloudHostsClient.startHost(ask.hostId),
            "Couldn't start the machine",
            () => {
              setStartAsk((current) => (current?.hostId === ask.hostId ? null : current));
              if (!ask.stale?.()) ask.then?.();
            }
          );
        }}
      >
        {startBusy && (
          <OperationProgress status={startStatus} fallback="Asking the provider to start it" />
        )}
        {startAsk && errorFor(startAsk.hostId) && (
          <InlineError role="alert">{errorFor(startAsk.hostId)}</InlineError>
        )}
      </ConfirmDialog>
    </>
  );

  return {
    start,
    check,
    confirmStart: (request) => {
      setError(request.hostId, null);
      setStartAsk({ ...request, askedAt: Date.now() });
    },
    requestStop: (hostId, name) => {
      setError(hostId, null);
      setStopAsk({ hostId, name });
    },
    isPending: (hostId) => pending.has(hostId),
    errorFor,
    dialogs,
  };
}
