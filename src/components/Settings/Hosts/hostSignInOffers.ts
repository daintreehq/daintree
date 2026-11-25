import { canopyHostClient } from "@/clients/canopyHostClient";
import type { HostSignInTerminal } from "@shared/types/ipc/canopyHost";
import type { HostId } from "@shared/types/remoteHosts";

/**
 * A sign-in Main started on a host for one of this machine's assistants
 * (#18197), already running for this view under `consumer`. It is opened as
 * the CLI's row in Settings → Hosts opens one; opened after `expiresAt`, it
 * has already ended there.
 */
export interface HostSignInOffer {
  hostId: HostId;
  agentId: string;
  consumer: string;
  terminal: HostSignInTerminal;
  expiresAt: number;
}

type Listener = (offer: HostSignInOffer) => void;

const listeners = new Set<Listener>();
let pending: HostSignInOffer | null = null;
let openDialogs = 0;

function letGo(offer: HostSignInOffer): void {
  void canopyHostClient.releaseSignIn(offer.consumer).catch(() => {});
}

/**
 * Hand an assistant's sign-in to Settings → Hosts: at once when the tab is
 * showing, otherwise held until it mounts, since opening the tab is part of
 * it. Refused (and ended on its host) while a sign-in dialog is open in this
 * view, since that one is the person's; an offer waiting for the tab gives way
 * to a newer one. False when it was refused.
 */
export function offerHostSignIn(offer: HostSignInOffer): boolean {
  if (openDialogs > 0) {
    letGo(offer);
    return false;
  }
  if (listeners.size === 0) {
    if (pending !== null) letGo(pending);
    pending = offer;
    return true;
  }
  if (pending !== null) letGo(pending);
  pending = null;
  for (const listener of [...listeners]) listener(offer);
  return true;
}

/** The offer made before the tab was showing, if it hasn't ended meanwhile; taking it clears it. */
export function takePendingHostSignIn(now: number): HostSignInOffer | null {
  const offer = pending;
  pending = null;
  if (offer === null) return null;
  if (now >= offer.expiresAt) {
    letGo(offer);
    return null;
  }
  return offer;
}

export function onHostSignInOffer(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Held while a sign-in dialog is open in this view; the call lets go of it. */
export function holdSignInDialog(): () => void {
  openDialogs++;
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    openDialogs--;
  };
}
