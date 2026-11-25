import { useEffect, useRef, useState, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/Callout";
import { InlineError } from "@/components/ui/field";
import { RadioChoiceGroup, RadioChoiceRow } from "@/components/ui/RadioChoice";
import { Skeleton, SkeletonBone } from "@/components/ui/Skeleton";
import { cloudHostsClient } from "@/clients/cloudHostsClient";
import { offerPriceLabel, sentenceCase } from "@/components/Hosts/cloud/cloudHostLabels";
import { useDohertyGate, useSkeletonDisplayFloor } from "@/hooks/useDeferredLoading";
import { UI_STILL_WORKING_MS } from "@/lib/animationUtils";
import { cn } from "@/lib/utils";
import { clientErrorText, isClientAppError } from "@/utils/clientAppError";
import type { CloudCreateOffer, CloudCreateOfferChoice } from "@shared/types/cloudHosts";
import type { HostId } from "@shared/types/remoteHosts";

/**
 * How long an order waits for its first offer before the person hears that none came.
 * Akash's bidders answer in about 5 to 30 seconds; one arriving later still shows.
 */
export const OFFER_WAIT_MS = 30_000;

/** A settings group's bare radio rows: hairlines between, the ring inside the row. */
const SETTINGS_ROW =
  "px-4 py-3 transition-colors has-[input:focus-visible]:outline has-[input:focus-visible]:outline-2 has-[input:focus-visible]:-outline-offset-2 has-[input:focus-visible]:outline-accent-primary";

function errorText(err: unknown, fallback: string): string {
  return isClientAppError(err) && err.userMessage
    ? err.userMessage
    : clientErrorText(err, fallback);
}

/** "99.9% uptime", to a tenth at most. */
function uptimeLabel(percent: number): string {
  return `${Number(percent.toFixed(1))}% uptime`;
}

/** Those that can be chosen first, then the cheapest; a tie keeps the provider's order. */
function inOrder(offers: CloudCreateOffer[]): CloudCreateOffer[] {
  return offers
    .map((offer, index) => ({ offer, index }))
    .sort(
      (a, b) =>
        Number(b.offer.choosable) - Number(a.offer.choosable) ||
        a.offer.hourlyDollars - b.offer.hourlyDollars ||
        a.index - b.index
    )
    .map(({ offer }) => offer);
}

/**
 * A create waiting on the person to choose one of its order's offers: the offers
 * as they arrive, those that can't be chosen with why, and Lease offer and Cancel
 * order. Shown in Add cloud host and on the host's details alike, so closing the
 * dialog never hides an open order. Key it by order: a new order is a new choice.
 */
export function CloudOfferChoice({
  hostId,
  choice,
  name,
  surface,
  problem = null,
}: {
  hostId: HostId;
  choice: CloudCreateOfferChoice;
  /** The radio group's name, distinct per surface. */
  name: string;
  /** A dialog's cards, or a settings group's rows. */
  surface: "dialog" | "settings";
  /** Why the host can't be served now, or what last went wrong with it; null for nothing. */
  problem?: string | null;
}) {
  const orderId = choice.order.id;
  const offers = inOrder(choice.offers);
  const settings = surface === "settings";
  // Kept with the price it was chosen at: a different quote is a different decision.
  const [selection, setSelection] = useState<{ id: string; hourlyDollars: number } | null>(null);
  const [selectionLost, setSelectionLost] = useState(false);
  const [busy, setBusy] = useState<"lease" | "cancel" | "retry" | null>(null);
  // A lease or cancel that went through holds the buttons until a later snapshot arrives:
  // the one in view when it answered, not the one it was sent from, which a push meanwhile
  // already replaced.
  const [heldFor, setHeldFor] = useState<CloudCreateOfferChoice | null>(null);
  const latestChoice = useRef(choice);
  useEffect(() => {
    latestChoice.current = choice;
  }, [choice]);
  const [error, setError] = useState<string | null>(null);
  const [retriedAt, setRetriedAt] = useState<number | null>(null);
  // Once any offer has shown, an empty list is offers withdrawn, not offers yet to come.
  const [hadOffers, setHadOffers] = useState(choice.offers.length > 0);

  const chosen =
    selection === null
      ? null
      : (offers.find(
          (offer) =>
            offer.id === selection.id &&
            offer.choosable &&
            offer.hourlyDollars === selection.hourlyDollars
        ) ?? null);
  const chosenGone = selection !== null && chosen === null;
  useEffect(() => {
    // Never carried to another bidder, nor back if the same offer returns: they choose again.
    if (!chosenGone) return;
    setSelection(null);
    setSelectionLost(true);
  }, [chosenGone]);

  // The wait for a first offer, from when this device began waiting or last asked again.
  const waiting = offers.length === 0;
  useEffect(() => {
    if (!waiting) setHadOffers(true);
  }, [waiting]);
  const windowStart = Math.max(choice.waitingSince, retriedAt ?? 0);
  const slowAt = windowStart + UI_STILL_WORKING_MS;
  const doneAt = windowStart + OFFER_WAIT_MS;
  const [now, setNow] = useState(() => Date.now());
  const nextDeadline = !waiting ? null : now < slowAt ? slowAt : now < doneAt ? doneAt : null;
  useEffect(() => {
    if (nextDeadline === null) return undefined;
    const timer = setTimeout(
      () => setNow(Math.max(Date.now(), nextDeadline)),
      Math.max(0, nextDeadline - Date.now())
    );
    return () => clearTimeout(timer);
  }, [nextDeadline]);
  const noneCame = waiting && now >= doneAt;
  const skeleton = useSkeletonDisplayFloor(useDohertyGate(waiting && !noneCame));

  const locked = busy !== null || heldFor === choice;

  const lease = () => {
    if (!chosen || locked) return;
    setBusy("lease");
    setError(null);
    setSelectionLost(false);
    cloudHostsClient.chooseOffer(hostId, orderId, chosen.id, chosen.hourlyDollars).then(
      () => {
        setBusy(null);
        setHeldFor(latestChoice.current);
      },
      (err: unknown) => {
        setBusy(null);
        // The order stays open: whatever is left can be chosen afresh.
        setSelection(null);
        setError(errorText(err, "Couldn't lease the offer"));
      }
    );
  };

  const cancel = () => {
    if (locked) return;
    setBusy("cancel");
    setError(null);
    cloudHostsClient.cancelOrder(hostId, orderId).then(
      () => {
        setBusy(null);
        setHeldFor(latestChoice.current);
      },
      (err: unknown) => {
        setBusy(null);
        setError(errorText(err, "Couldn't cancel the order"));
      }
    );
  };

  const retry = () => {
    if (locked) return;
    const askedAt = Date.now();
    setBusy("retry");
    setError(null);
    cloudHostsClient.refreshOffers(hostId, orderId).then(
      () => {
        setBusy(null);
        setRetriedAt(askedAt);
        setNow(Date.now());
      },
      (err: unknown) => {
        setBusy(null);
        setError(errorText(err, "Couldn't read the offers again"));
      }
    );
  };

  let offersView: ReactNode = null;
  if (!waiting && !skeleton) {
    offersView = (
      <RadioChoiceGroup
        legend="Offers"
        legendHidden={settings}
        className={settings ? "space-y-0 divide-y divide-border-subtle" : undefined}
      >
        {offers.map((offer) => {
          const price = offerPriceLabel(offer.hourlyDollars);
          const facts = [
            offer.choosable ? null : price,
            offer.bidder.region,
            offer.bidder.uptimePercent === undefined
              ? null
              : uptimeLabel(offer.bidder.uptimePercent),
          ].filter((fact): fact is string => fact !== null && fact !== "");
          const audited = offer.bidder.audited === true;
          const checked = chosen?.id === offer.id;
          return (
            <RadioChoiceRow
              key={offer.id}
              bare={settings}
              // A bidder's name or refusal is the provider's text: one long token still wraps.
              className={cn(
                "break-words",
                settings && SETTINGS_ROW,
                settings && (checked ? "bg-overlay-selected" : "hover:bg-overlay-soft")
              )}
              name={name}
              value={offer.id}
              checked={checked}
              disabled={!offer.choosable || locked}
              onChange={() => {
                setSelection({ id: offer.id, hourlyDollars: offer.hourlyDollars });
                setSelectionLost(false);
              }}
              label={offer.bidder.name}
              description={offer.choosable ? price : sentenceCase(offer.reason)}
              details={
                facts.length > 0 || audited ? (
                  <>
                    {facts.join(" · ")}
                    {audited && (
                      <>
                        {facts.length > 0 && " "}
                        <Badge size="xs">Audited</Badge>
                      </>
                    )}
                  </>
                ) : undefined
              }
            />
          );
        })}
      </RadioChoiceGroup>
    );
  } else if (noneCame && !skeleton) {
    offersView = (
      <Callout
        severity="info"
        data-testid="cloud-offer-none"
        action={
          <Button
            variant="outline"
            size="sm"
            loading={busy === "retry"}
            disabled={locked}
            onClick={retry}
          >
            Retry
          </Button>
        }
      >
        {hadOffers
          ? "Its offers were withdrawn, and none have come in since."
          : choice.offersReadAt === null
            ? "Daintree hasn't heard back about the order yet."
            : "No offers have arrived yet."}
      </Callout>
    );
  } else if (skeleton) {
    offersView = (
      <div className="space-y-2">
        <Skeleton
          label="Waiting for offers"
          className="space-y-2"
          data-testid="cloud-offer-waiting"
        >
          <SkeletonBone immediate heightPx={52} className="rounded-[var(--radius-md)]" />
          <SkeletonBone immediate heightPx={52} className="rounded-[var(--radius-md)]" />
        </Skeleton>
        {waiting && now >= slowAt && (
          <p className="text-xs text-text-secondary" data-testid="cloud-offer-still-working">
            Still working…
          </p>
        )}
      </div>
    );
  }
  const listShown = !waiting && !skeleton;
  const canPickAgain = offers.some((offer) => offer.choosable);

  const notes = (selectionLost || problem || error) && (
    <div className={settings ? "space-y-1 px-4 py-3" : "space-y-3"}>
      {selectionLost && (
        <p className="text-xs text-text-secondary" data-testid="cloud-offer-choice-lost">
          {canPickAgain
            ? "The offer you picked changed or was withdrawn. Pick one again."
            : "The offer you picked changed or was withdrawn."}
        </p>
      )}
      {problem && !error && <InlineError>{problem}</InlineError>}
      {error && <InlineError role="alert">{error}</InlineError>}
    </div>
  );

  return (
    <div
      className={settings ? "divide-y divide-border-subtle" : "space-y-3"}
      data-testid="cloud-offer-choice"
    >
      {offersView &&
        (settings && !listShown ? <div className="px-4 py-3">{offersView}</div> : offersView)}
      {notes}
      <div className={cn("flex flex-wrap gap-2", settings && "px-4 py-3")}>
        {!waiting && (
          <Button
            variant="contrast"
            size="sm"
            loading={busy === "lease"}
            disabled={locked || chosen === null}
            onClick={lease}
          >
            Lease offer
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          loading={busy === "cancel"}
          disabled={locked}
          onClick={cancel}
        >
          Cancel order
        </Button>
      </div>
    </div>
  );
}
