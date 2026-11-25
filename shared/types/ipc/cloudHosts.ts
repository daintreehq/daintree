/**
 * The order a cloud host's create placed with an offer-based provider, as the
 * asking view read it from `CloudHostStatus.pendingCreate` (#18230). Main acts
 * only while that order is still the host's, so a stale view never touches a
 * later one.
 */
export interface CloudOrderRequest {
  hostId: string;
  orderId: string;
}

/** One offer on that order, chosen by the person: the only path that leases a machine there. */
export interface CloudOfferChoiceRequest extends CloudOrderRequest {
  offerId: string;
  /**
   * The rate the person saw for it, in dollars per running hour. A bidder can
   * quote again under the same offer id; one that no longer quotes this rate
   * is refused, with nothing leased and the order left open.
   */
  hourlyDollars: number;
}
