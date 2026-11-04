import { RelayClient } from "@daintreehq/decisions-client";
import type { EventsPage, ProtocolFeature } from "@daintreehq/decisions-protocol";

/**
 * The protocol extensions (Decisions protocol section 19) Daintree declares to
 * its relay: none yet (#16229). A relay sends a desktop only what it declared,
 * and a phone offers follow-ups, images or a terminal refresh on a question
 * only when the desktop that asked it declared that feature, so each one joins
 * this list with the Daintree work that handles it.
 */
export const DAINTREE_PROTOCOL_FEATURES: readonly ProtocolFeature[] = [];

function declared(features: readonly ProtocolFeature[]): ProtocolFeature[] {
  return features.filter((feature) => DAINTREE_PROTOCOL_FEATURES.includes(feature));
}

/**
 * The library's client, declaring only `DAINTREE_PROTOCOL_FEATURES` on its
 * socket tickets and event pages. The 0.4.0 bridge always asks for
 * `phone-images-v1`, which would let a phone attach images to an answer that
 * Daintree's sink can't yet type. The declaration is cut here, before the
 * request is signed.
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
