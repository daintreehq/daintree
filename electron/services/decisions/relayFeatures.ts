import { RelayClient } from "@daintreehq/decisions-client";
import type { EventsPage, ProtocolFeature } from "@daintreehq/decisions-protocol";

/**
 * The protocol extensions (Decisions protocol section 19) Daintree declares to
 * its relay (#16229). A relay sends a desktop only what it declared, and a
 * phone offers follow-ups, images or a terminal refresh on a question only
 * when the desktop that asked it declared that feature, so each one joins
 * this list with the Daintree work that handles it: follow-ups with their
 * typing (#16231), pane snapshots with #16230, which a bridge asks for only
 * when its connection publishes them, phone images with their storing
 * (#16233), the involvement preference's change hints with
 * `get_involvement` (#17228), and the person's answers the owner desktop
 * signs with their typing as answers made on the computer (#17101), which a
 * relay commits to a question only once the desktop that asked it declared
 * it, the owner's own and a Remote Host's alike. Person declines wait for the
 * issue that handles them (#17234). From 0.8.0 the library also asks for
 * `owner-desktop-messages-v1` with follow-ups and `owner-desktop-declines-v1`
 * always: each stays cut here until the person's follow-ups (#17238) and
 * declines (#17239) from this computer, and `presence-v1` until presence
 * (#17240). Setting the involvement preference from this computer (#17237)
 * has no token of its own: it rides `involvement-v1`.
 */
export const DAINTREE_PROTOCOL_FEATURES: readonly ProtocolFeature[] = [
  "thread-messages-v1",
  "pane-snapshots-v1",
  "phone-images-v1",
  "involvement-v1",
  "owner-desktop-answers-v1",
];

function declared(features: readonly ProtocolFeature[]): ProtocolFeature[] {
  return features.filter((feature) => DAINTREE_PROTOCOL_FEATURES.includes(feature));
}

/**
 * The library's client, declaring only `DAINTREE_PROTOCOL_FEATURES` on its
 * socket tickets and event pages, so a feature a later bridge asks for is
 * cut here, before the request is signed, until Daintree handles it.
 */
export class DaintreeRelayClient extends RelayClient {
  override events(
    after: number,
    limit?: number,
    features: readonly ProtocolFeature[] = []
  ): Promise<EventsPage> {
    return super.events(after, limit, declared(features));
  }

  override socketTicket(
    features: readonly ProtocolFeature[] = []
  ): ReturnType<RelayClient["socketTicket"]> {
    return super.socketTicket(declared(features));
  }
}
