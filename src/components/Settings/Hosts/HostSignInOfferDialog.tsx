import { useEffect, useState } from "react";
import { getAgentConfig } from "@shared/config/agentRegistry";
import type { HostSignInOffer } from "./HostSignInOffers";
import { HostAgentSignInDialog, type OfferSettled } from "./HostAgentSignInDialog";
import { signInDialogOpen } from "./signInDialogHold";

/**
 * The dialog a CLI's row in Settings → Hosts opens, on a sign-in Main started
 * for an assistant. Read when it first renders, since it may load after the
 * offer arrived: a sign-in the person opened meanwhile keeps the view, and
 * this one gives way, ending it on its host.
 */
export default function HostSignInOfferDialog({
  offer,
  onSettled,
  onClose,
}: {
  offer: HostSignInOffer;
  onSettled: (settled: OfferSettled) => void;
  onClose: () => void;
}) {
  const [personsOpen] = useState(() => signInDialogOpen());
  useEffect(() => {
    if (personsOpen) onSettled("gone");
  }, [personsOpen, onSettled]);
  if (personsOpen) return null;
  return (
    <HostAgentSignInDialog
      hostId={offer.hostId}
      hostName={offer.hostName}
      agentId={offer.agentId}
      agentName={getAgentConfig(offer.agentId)?.name ?? offer.agentId}
      offered={{ consumer: offer.consumer, terminal: offer.terminal }}
      onOfferSettled={onSettled}
      onClose={onClose}
    />
  );
}
