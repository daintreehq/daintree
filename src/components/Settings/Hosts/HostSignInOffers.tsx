import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { canopyHostClient } from "@/clients/canopyHostClient";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import type { CanopyHostEvent } from "@shared/types/ipc/canopyHost";
import { signInDialogOpen } from "./signInDialogHold";

/** A sign-in Main started on a host for the assistant this view shows (#18197), running for this view. */
export type HostSignInOffer = Omit<Extract<CanopyHostEvent, { kind: "sign-in-offer" }>, "kind">;

const loadDialog = () => lazy(() => import("./HostSignInOfferDialog"));
// Made again after a failed load: a lazy component keeps its rejected import.
let HostSignInOfferDialog = loadDialog();

/**
 * Past Main's deadline before the dialog is put away unless shown: Main says
 * `gone` to anything later, and an answer of `shown` may still be on its way.
 */
const CLOSE_GRACE_MS = 5_000;

function letGo(consumer: string): void {
  void canopyHostClient.releaseSignIn(consumer).catch(() => {});
}

const NO_FALLBACK = () => null;

/**
 * Opens an agent CLI sign-in Main started on a host for the assistant this
 * view shows (#18197), in the dialog that CLI's row in Settings → Hosts opens,
 * over whatever the person has open: nothing is navigated away from. Only Main
 * sends these, to the view it chose. One that already ended is let be; one met
 * by a sign-in dialog already open here is refused, which ends it on its host,
 * since that dialog is the person's. This owns an offer until its dialog does,
 * and puts the dialog away once Main says nothing waits on it, or at its
 * deadline unless Main took it as shown: Main has ended it on its host by then.
 */
export function HostSignInOffers() {
  const [offer, setOffer] = useState<HostSignInOffer | null>(null);
  const showing = useRef<{ consumer: string; expiresAt: number } | null>(null);
  const taken = useRef(false);

  useEffect(() => {
    const onEvent = window.electron?.canopyHost?.onEvent;
    if (!onEvent) return undefined;
    return onEvent((event) => {
      if (event.kind !== "sign-in-offer") return;
      // Main ended it at this time; a push that arrived late opens nothing.
      if (Date.now() >= event.expiresAt) return;
      // One Main already ended, never shown, gives way to a newer one.
      const stale =
        showing.current !== null && !taken.current && Date.now() >= showing.current.expiresAt;
      if (showing.current !== null ? !stale : signInDialogOpen()) {
        letGo(event.consumer);
        return;
      }
      if (stale && showing.current !== null) letGo(showing.current.consumer);
      showing.current = { consumer: event.consumer, expiresAt: event.expiresAt };
      taken.current = false;
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

  useEffect(() => {
    if (offer === null) return undefined;
    const timer = setTimeout(
      () => {
        if (taken.current || showing.current?.consumer !== offer.consumer) return;
        showing.current = null;
        setOffer(null);
      },
      Math.max(0, offer.expiresAt - Date.now()) + CLOSE_GRACE_MS
    );
    return () => clearTimeout(timer);
  }, [offer]);

  if (offer === null) return null;
  const close = () => {
    showing.current = null;
    setOffer(null);
  };
  return (
    // A dialog that couldn't load (a chunk gone after a rebuild) ends its sign-in
    // rather than the app, and leaves room for the next one.
    <ErrorBoundary
      key={offer.consumer}
      variant="component"
      componentName="HostSignInOffers"
      fallback={NO_FALLBACK}
      onError={() => {
        HostSignInOfferDialog = loadDialog();
        letGo(offer.consumer);
        close();
      }}
    >
      <Suspense fallback={null}>
        <HostSignInOfferDialog
          offer={offer}
          onSettled={(settled) => {
            if (settled === "shown") {
              taken.current = true;
              return;
            }
            // Its dialog may never have mounted to let it go itself.
            letGo(offer.consumer);
            close();
          }}
          onClose={close}
        />
      </Suspense>
    </ErrorBoundary>
  );
}
