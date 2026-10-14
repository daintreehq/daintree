import { AppError } from "../../utils/errorTypes.js";
import type { LaneWakeSink } from "../assistant/AssistantLaneWaker.js";
import type { AssistantExchangeStore } from "./AssistantExchangeStore.js";
import { TERMINAL_EXCHANGE_STATES, type ExchangeActor, type ExchangeKey } from "./types.js";

/** The store's refusals that mean "not sendable", as opposed to a failed write. */
const NOT_SENDABLE = new Set(["NOT_FOUND", "VALIDATION", "OUTCOME_UNKNOWN"]);

/**
 * Records a lane wake's outcome on its exchange (#13333). Delivered and
 * ambiguous are delivery facts; held and unavailable go in the outcome code
 * beside the current state, which they never change. A typed wake is read
 * from `wakeTypedAt`, so a held code left from before it is history.
 */
export function exchangeWakeSink(
  store: AssistantExchangeStore,
  actor: ExchangeActor,
  key: ExchangeKey
): LaneWakeSink {
  return {
    beforeType: () => {
      try {
        store.beginDelivery(actor, key);
        return true;
      } catch (err) {
        if (err instanceof AppError && NOT_SENDABLE.has(err.code)) return false;
        throw err;
      }
    },
    report: (outcome) => {
      switch (outcome.kind) {
        case "delivered":
          store.recordDelivery(actor, key, "wake-typed");
          return;
        case "ambiguous":
          store.markAmbiguous(actor, key);
          return;
        default: {
          const record = store.get(actor, key);
          if (record === null || TERMINAL_EXCHANGE_STATES.has(record.state)) return;
          const code =
            outcome.kind === "unavailable"
              ? "wake-unavailable"
              : outcome.reason === "expired"
                ? "wake-expired"
                : "wake-held";
          store.setState(actor, key, record.state, code);
        }
      }
    },
  };
}
