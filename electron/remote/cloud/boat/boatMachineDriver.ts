import type { MachineKeeperArmRequest } from "../machineKeeperLink.js";
import type { MachineDriver, MachineKeeperFailure } from "../../host/MachineKeeper.js";
import { BoatApiError, type BoatClient } from "./BoatClient.js";
import { boatResource, boatStopResource } from "./BoatProvider.js";

/** What a refused request means for a machine's own key. */
export function boatMachineKeyFailure(error: unknown): MachineKeeperFailure {
  if (!(error instanceof BoatApiError)) return { kind: "retry" };
  switch (error.kind) {
    case "unauthorized":
      return {
        kind: "lost",
        problem:
          "Boat no longer accepts the key Daintree gave this machine. It may have been revoked.",
      };
    case "forbidden":
      return {
        kind: "lost",
        problem:
          error.code === "api_key_expired"
            ? "The key Daintree gave this machine expired. Connect to it from Daintree to renew it."
            : "Boat doesn't let the key Daintree gave this machine act on it.",
      };
    case "not-found":
      return { kind: "lost", problem: "Boat doesn't know this machine any more." };
    default:
      return { kind: "retry" };
  }
}

/** This sandbox, through the key limited to it that a Shell handed this host. */
export function boatMachineDriver(
  request: MachineKeeperArmRequest,
  client: BoatClient
): MachineDriver {
  const ctx = (signal: AbortSignal) => ({ apiKey: request.secret, org: request.scope, signal });
  return {
    inspect: async (signal) =>
      boatResource(await client.getSandbox(ctx(signal), request.resourceId)),
    renew: async (lifetimeSeconds, signal) =>
      boatResource(
        await client.updateSandbox(ctx(signal), request.resourceId, { ttlSeconds: lifetimeSeconds })
      ),
    stop: async (signal) =>
      boatStopResource(await client.stopSandbox(ctx(signal), request.resourceId, { once: true })),
    failure: boatMachineKeyFailure,
  };
}
