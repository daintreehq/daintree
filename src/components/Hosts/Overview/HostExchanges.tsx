import { useEffect, useState } from "react";
import type { AssistantExchangeView } from "@shared/types/ipc/remoteHosts";
import type { HostId } from "@shared/types/remoteHosts";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { TimeAgo } from "@/components/ui/TimeAgo";
import { remoteHostsClient } from "@/clients/remoteHostsClient";
import { pluralize } from "@/lib/pluralize";
import { clientErrorText } from "@/utils/clientAppError";
import type { HostProjectRef } from "../hostProjects";
import {
  describeExchangeDelivery,
  describeExchangeReceiver,
  describeExchangeState,
  shortConversationId,
} from "./exchangeModel";

interface HostExchangesProps {
  hostId: HostId;
  hostName: string;
  /** The host's current projects, to name a receiving lane's project; absent while unknown. */
  projects?: readonly HostProjectRef[] | null;
}

/** A card lists this many exchanges; the rest are counted. */
export const HOST_EXCHANGE_LIMIT = 5;

type LoadState =
  | { kind: "loading" }
  | { kind: "loaded"; exchanges: AssistantExchangeView[] }
  | { kind: "failed"; message: string; exchanges: AssistantExchangeView[] | null };

function ExchangeRow({
  exchange,
  projects,
  hostName,
  busy,
  onCancel,
}: {
  exchange: AssistantExchangeView;
  projects?: readonly HostProjectRef[] | null;
  hostName: string;
  busy: boolean;
  onCancel: (exchange: AssistantExchangeView) => void;
}) {
  const state = describeExchangeState(exchange);
  const delivery = describeExchangeDelivery(exchange);
  const receiver = describeExchangeReceiver(exchange, projects) ?? "Lane not known yet";
  const hops = pluralize(exchange.hopCount, "hop");
  return (
    <li
      className="flex min-w-0 flex-col gap-0.5 py-1"
      data-testid="host-exchange-row"
      data-message-id={exchange.messageId}
    >
      <div className="flex min-w-0 items-center gap-2 text-xs">
        <span className="min-w-0 truncate text-text-primary">
          {[state, delivery].filter(Boolean).join(" · ")}
        </span>
        <TimeAgo
          timestamp={exchange.sentAt}
          prefix="sent "
          className="shrink-0 text-2xs text-text-secondary"
        />
        {exchange.cancel === "requested" && (
          <span className="ml-auto shrink-0 text-2xs text-text-secondary">Cancel requested</span>
        )}
        {(exchange.cancel === "cancel" || exchange.cancel === "request") && (
          <Button
            variant="ghost"
            size="xs"
            className="ml-auto shrink-0"
            disabled={busy}
            aria-busy={busy || undefined}
            aria-label={`${exchange.cancel === "cancel" ? "Cancel exchange" : "Request cancel"} to ${receiver} on ${hostName}`}
            onClick={() => onCancel(exchange)}
          >
            {exchange.cancel === "cancel" ? "Cancel exchange" : "Request cancel"}
          </Button>
        )}
      </div>
      <span className="min-w-0 truncate text-2xs text-text-secondary">
        Hub → {receiver} · {hops}
        {exchange.contextId && (
          <>
            {" · conversation "}
            <span title={exchange.contextId}>{shortConversationId(exchange.contextId)}</span>
          </>
        )}
        {" · updated "}
        <TimeAgo timestamp={exchange.updatedAt} />
      </span>
    </li>
  );
}

/**
 * The exchanges this Shell's hub sent to assistants on one host, as this
 * Shell's journal last knew them, so they show while the host is away too.
 * States are the host's own; delivery says what was seen, and an outcome
 * nobody saw reads as unconfirmed, never as success or failure.
 */
export function HostExchanges({ hostId, hostName, projects }: HostExchangesProps) {
  const [load, setLoad] = useState<LoadState>({ kind: "loading" });
  const [showAll, setShowAll] = useState(false);
  const [confirming, setConfirming] = useState<AssistantExchangeView | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);
  /** Bumped to read again on demand (Retry, after a cancel). */
  const [readNonce, setReadNonce] = useState(0);

  useEffect(() => {
    let seq = 0;
    let live = true;
    const read = () => {
      const mine = ++seq;
      remoteHostsClient.listAssistantExchanges(hostId).then(
        (exchanges) => {
          if (live && mine === seq) setLoad({ kind: "loaded", exchanges });
        },
        (error: unknown) => {
          if (!live || mine !== seq) return;
          setLoad((previous) => ({
            kind: "failed",
            message: clientErrorText(error, "Couldn't load assistant exchanges"),
            exchanges: previous.kind === "loading" ? null : previous.exchanges,
          }));
        }
      );
    };
    // Listening before the first read, so a change that lands meanwhile reads again.
    const off = remoteHostsClient.onEvent((event) => {
      if (event.type === "exchanges-changed" && event.hostId === hostId) read();
    });
    read();
    return () => {
      live = false;
      off();
    };
  }, [hostId, readNonce]);

  const refresh = () => setReadNonce((n) => n + 1);

  const confirmCancel = async () => {
    const exchange = confirming;
    if (!exchange) return;
    setConfirming(null);
    setCancelling(exchange.messageId);
    setCancelError(null);
    try {
      await remoteHostsClient.cancelAssistantExchange(hostId, exchange.messageId);
    } catch (error) {
      setCancelError(clientErrorText(error, "Couldn't cancel the exchange"));
    } finally {
      setCancelling(null);
      // The host's answer decides what happened; show what the journal now holds.
      refresh();
    }
  };

  const exchanges = load.kind === "loading" ? null : load.exchanges;
  if (load.kind === "loading" || (load.kind === "loaded" && load.exchanges.length === 0)) {
    return null;
  }

  const list = exchanges ?? [];
  const shown = showAll ? list : list.slice(0, HOST_EXCHANGE_LIMIT);
  const more = list.length - shown.length;
  const confirmingReceiver = confirming
    ? (describeExchangeReceiver(confirming, projects) ?? "Lane not known yet")
    : "";
  const isRequest = confirming?.cancel === "request";

  return (
    <section aria-label={`Assistant exchanges with ${hostName}`} data-testid="host-exchanges">
      <h4 className="mb-1 text-2xs font-medium text-text-secondary">Assistant exchanges</h4>
      {load.kind === "failed" && (
        <div className="flex items-center gap-2 text-xs">
          <span role="alert" className="text-status-error">
            {load.message}
          </span>
          <Button variant="ghost" size="xs" onClick={refresh}>
            Retry
          </Button>
        </div>
      )}
      {cancelError && (
        <p role="alert" className="text-xs text-status-error">
          {cancelError}
        </p>
      )}
      {shown.length > 0 && (
        <ul className="flex flex-col">
          {shown.map((exchange) => (
            <ExchangeRow
              key={exchange.messageId}
              exchange={exchange}
              projects={projects}
              hostName={hostName}
              busy={cancelling === exchange.messageId}
              onCancel={setConfirming}
            />
          ))}
        </ul>
      )}
      {more > 0 && (
        <Button variant="ghost" size="xs" className="mt-0.5" onClick={() => setShowAll(true)}>
          Show {pluralize(more, "more exchange")}
        </Button>
      )}
      <ConfirmDialog
        isOpen={confirming !== null}
        onClose={() => setConfirming(null)}
        variant="destructive"
        title={
          isRequest
            ? `Request cancel of the exchange with ${confirmingReceiver}?`
            : `Cancel the exchange with ${confirmingReceiver}?`
        }
        description={
          isRequest
            ? `It may already have reached the assistant on ${hostName}, which may have acted on it. ${hostName} records the request; it can't undo anything already done.`
            : `Nothing has reached the assistant on ${hostName} yet. If that is still so, it never will. If delivery started meanwhile, ${hostName} records a cancel request instead.`
        }
        confirmLabel={isRequest ? "Request cancel" : "Cancel exchange"}
        cancelLabel="Keep exchange"
        onConfirm={confirmCancel}
      >
        {confirming && (
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
            <dt className="text-text-secondary">From</dt>
            <dd className="text-text-primary">This machine's hub</dd>
            <dt className="text-text-secondary">To</dt>
            <dd className="min-w-0 truncate text-text-primary">
              {confirmingReceiver} on {hostName}
            </dd>
            <dt className="text-text-secondary">State</dt>
            <dd className="text-text-primary">
              {[describeExchangeState(confirming), describeExchangeDelivery(confirming)]
                .filter(Boolean)
                .join(" · ")}
            </dd>
            {confirming.contextId && (
              <>
                <dt className="text-text-secondary">Conversation</dt>
                <dd className="min-w-0 truncate text-text-primary">{confirming.contextId}</dd>
              </>
            )}
            <dt className="text-text-secondary">Message</dt>
            <dd className="min-w-0 truncate text-text-primary">{confirming.messageId}</dd>
          </dl>
        )}
      </ConfirmDialog>
    </section>
  );
}
