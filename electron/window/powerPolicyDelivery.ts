import type { WebContents } from "electron";
import type { PowerPolicySnapshot } from "../../shared/types/powerPolicy.js";
import { CHANNELS } from "../ipc/channels.js";
import { getPowerPolicy } from "./powerPolicy.js";
import { getAllAppWebContents } from "./webContentsRegistry.js";
import { sendLatestWins } from "./frozenViewDelivery.js";

const POWER_POLICY_EVENT = "system:power-policy-changed";
// Keyed by event name: other `events:push` events sharing the channel are not
// replaceable by this one.
const POWER_POLICY_KEY = `${CHANNELS.EVENTS_PUSH}:${POWER_POLICY_EVENT}`;

function envelope(snapshot: PowerPolicySnapshot) {
  return { name: POWER_POLICY_EVENT, payload: snapshot };
}

function sendPolicy(wc: WebContents, snapshot: PowerPolicySnapshot): void {
  sendLatestWins(wc, POWER_POLICY_KEY, CHANNELS.EVENTS_PUSH, envelope(snapshot));
}

/**
 * Every view, cached ones included: a cached view keeps its motion suppressed
 * on its own, but it must already hold the current policy when it comes back.
 * A frozen one holds only the newest policy until it thaws (#17038).
 */
export function publishPowerPolicy(snapshot: PowerPolicySnapshot): void {
  let targets: WebContents[];
  try {
    targets = getAllAppWebContents();
  } catch {
    return;
  }
  for (const wc of targets) sendPolicy(wc, snapshot);
}

/**
 * Hand a freshly loaded view the current policy. Broadcasts only reach views
 * that already exist, and a renderer boots assuming `active`, so a view loaded
 * while the policy is anything else needs its own copy.
 */
export function deliverPowerPolicy(wc: WebContents): void {
  const snapshot = getPowerPolicy();
  if (snapshot.level === "active") return;
  sendPolicy(wc, snapshot);
}
