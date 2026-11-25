import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { canopyHostClient } from "@/clients/canopyHostClient";
import type { CanopyHostEvent } from "@shared/types/ipc/canopyHost";
import { signInDialogOpen } from "./signInDialogHold";

/** A sign-in Main started on a host for the assistant this view shows (#18197), running for this view. */
export type HostSignInOffer = Omit<Extract<CanopyHostEvent, { kind: "sign-in-offer" }>, "kind">;

const HostSignInOfferDialog = lazy(() => import("./HostSignInOfferDialog"));

function letGo(consumer: string): void {
  void canopyHostClient.releaseSignIn(consumer).catch(() => {});
}

/**
 * Opens an agent CLI sign-in Main started on a host for the assistant this
 * view shows (#18197), in the dialog that CLI's row in Settings → Hosts opens,
 * over whatever the person has open: nothing is navigated away from. Only Main
 * sends these, to the view it chose. One that already ended is let be; one met
 * by a sign-in dialog already open here is refused, which ends it on its host,
 * since that dialog is the person's. This owns an offer until its dialog does.
 */
export function HostSignInOffers() {
  const [offer, setOffer] = useState<HostSignInOffer | null>(null);
  const showing = useRef<string | null>(null);

  useEffect(() => {
    const onEvent = window.electron?.canopyHost?.onEvent;
    if (!onEvent) return undefined;
    return onEvent((event) => {
      if (event.kind !== "sign-in-offer") return;
      // Main ended it at this time; a push that arrived late opens nothing.
      if (Date.now() >= event.expiresAt) return;
      if (showing.current !== null || signInDialogOpen()) {
        letGo(event.consumer);
        return;
      }
      showing.current = event.consumer;
      setOffer({
        hostId: event.hostId,
        hostName: event.hostName,
        agentId: event.agentId,
        consumer: event.consumer,
        terminal: event.terminal,
        expiresAt: event.expiresAt,
      });
    });
  }, []);

  if (offer === null) return null;
  return (
    <Suspense fallback={null}>
      <HostSignInOfferDialog
        key={offer.consumer}
        offer={offer}
        onClose={() => {
          showing.current = null;
          setOffer(null);
        }}
      />
    </Suspense>
  );
}
