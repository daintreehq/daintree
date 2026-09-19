import type { WebContents } from "electron";
import type { PowerPolicySnapshot } from "../../shared/types/powerPolicy.js";
import { CHANNELS } from "../ipc/channels.js";
import { getPowerPolicy } from "./powerPolicy.js";
import { getAllAppWebContents } from "./webContentsRegistry.js";

function envelope(snapshot: PowerPolicySnapshot) {
  return { name: "system:power-policy-changed", payload: snapshot };
}

/**
 * Every view, cached ones included: a cached view keeps its motion suppressed
 * on its own, but it must already hold the current policy when it comes back.
 */
export function publishPowerPolicy(snapshot: PowerPolicySnapshot): void {
  let targets: WebContents[];
  try {
    targets = getAllAppWebContents();
  } catch {
    return;
  }
  for (const wc of targets) {
    try {
      if (wc.isDestroyed()) continue;
      wc.send(CHANNELS.EVENTS_PUSH, envelope(snapshot));
    } catch {
      // A view tearing down must not cost the others their copy.
    }
  }
}

/**
 * Hand a freshly loaded view the current policy. Broadcasts only reach views
 * that already exist, and a renderer boots assuming `active`, so a view loaded
 * while the policy is anything else needs its own copy.
 */
export function deliverPowerPolicy(wc: WebContents): void {
  const snapshot = getPowerPolicy();
  if (snapshot.level === "active") return;
  try {
    if (wc.isDestroyed()) return;
    wc.send(CHANNELS.EVENTS_PUSH, envelope(snapshot));
  } catch {
    // Retried on the view's next load.
  }
}
