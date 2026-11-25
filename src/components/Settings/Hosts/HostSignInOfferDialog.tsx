import { getAgentConfig } from "@shared/config/agentRegistry";
import type { HostSignInOffer } from "./HostSignInOffers";
import { HostAgentSignInDialog, type OfferSettled } from "./HostAgentSignInDialog";

/** The dialog a CLI's row in Settings → Hosts opens, on a sign-in Main started for an assistant. */
export default function HostSignInOfferDialog({
  offer,
  onSettled,
  onClose,
}: {
  offer: HostSignInOffer;
  onSettled: (settled: OfferSettled) => void;
  onClose: () => void;
}) {
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
