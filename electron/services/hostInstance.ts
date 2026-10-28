import { randomUUID } from "node:crypto";

/**
 * Names this launch of Daintree. A revision a Shell read before a restart
 * never matches after it, even when a counter has started over at the same
 * number (#14167). Canopy's `hostEpoch` is this id.
 */
export const hostInstanceId = randomUUID();
