import { getAgentConfig } from "@shared/config/agentRegistry";
import type { HostSignInOffer } from "./HostSignInOffers";
import { HostAgentSignInDialog } from "./HostAgentSignInDialog";

/** The dialog a CLI's row in Settings → Hosts opens, on a sign-in Main started for an assistant. */
export default function HostSignInOfferDialog({
  offer,
  onClose,
}: {
  offer: HostSignInOffer;
  onClose: () => void;
}) {
  return (
    <HostAgentSignInDialog
      hostId={offer.hostId}
      hostName={offer.hostName}
      agentId={offer.agentId}
      agentName={getAgentConfig(offer.agentId)?.name ?? offer.agentId}
      offered={{ consumer: offer.consumer, terminal: offer.terminal }}
      onClose={onClose}
    />
  );
}
