import * as protocol from "@daintreehq/decisions-protocol";
import * as decisionsCrypto from "@daintreehq/decisions-crypto";
import * as client from "@daintreehq/decisions-client";
import * as model from "@daintreehq/decisions-model";

/**
 * The published Decisions libraries, bound here so they are bundled into the
 * service's lazy chunk and nowhere else: nothing on the startup path names
 * them, so with Decisions off none of their code is ever read. Each later
 * child takes what it needs from this binding or imports it beside the service.
 */
export const decisionsLibraries = Object.freeze({
  protocol,
  crypto: decisionsCrypto,
  client,
  model,
});

export type DecisionsLibraries = typeof decisionsLibraries;
