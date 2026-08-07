import { randomUUID } from "node:crypto";
import { BrowserWindow } from "electron";
import { defineIpcNamespace, op } from "../define.js";
import type { IpcContext } from "../types.js";
import { CHANNELS } from "../channels.js";
import { PLUGIN_CAPABILITY_METHOD_CHANNELS } from "./pluginCapability.preload.js";
import { getPluginCapabilityConsentService } from "../../services/plugin-capability/instances.js";
import type {
  PluginCapabilityConsentBridge,
  PluginCapabilityConsentRequest,
} from "../../services/plugin-capability/PluginCapabilityConsentService.js";
import { getMainWindow } from "../../window/windowRef.js";
import { getAppWebContents } from "../../window/webContentsRegistry.js";
import {
  PLUGIN_CAPABILITY_CONSENT_DELIVERY_TIMEOUT_MS,
  PLUGIN_CAPABILITY_CONSENT_RESEND_INTERVAL_MS,
  PLUGIN_CAPABILITY_CONSENT_TIMEOUT_MS,
  type PluginCapabilityAcknowledgeConsentInput,
  type PluginCapabilityConsentOutcome,
  type PluginCapabilityResolveConsentInput,
} from "../../../shared/types/pluginCapabilityConsent.js";

// --- Consent bridge (main → renderer prompt, renderer → main decision) --------
//
// `PluginCapabilityConsentService.ensureAllowed` blocks on an injected bridge
// when a first-use prompt is required. Unlike the plugin-MCP consent bridge,
// the gated call originates in the plugin's own utility process — there is no
// initiating renderer to pin to — so the prompt is sent to the focused window,
// falling back to the primary window. The renderer replies via
// `plugin-capability:resolve-consent`, correlated by `requestId`.
//
// Which WebContents *inside* that window matters (#11708). The BrowserWindow is
// only a shell — it stays at `about:blank` with no preload attached — while the
// React app lives in a child WebContentsView registered through
// `webContentsRegistry`. Pushing to `win.webContents` therefore delivered every
// prompt into an empty document: `send()` to a listener-less renderer neither
// throws nor logs, so the failure was invisible until the five-minute timeout
// fired and reported itself to the plugin as a user denial. `getAppWebContents`
// is the established lookup for "the renderer actually running the app".
//
// Because that class of failure is silent by construction, routing correctly is
// not enough to *know* it worked. The renderer acknowledges receipt as soon as
// it enqueues the prompt, and the bridge re-pushes until that receipt arrives —
// which also covers a cold project switch, where the app view is registered
// before React has mounted the consent listener. An unacknowledged prompt
// settles `undeliverable` in seconds instead of failing closed as a denial the
// user never made.

interface PendingConsent {
  resolve: (outcome: PluginCapabilityConsentOutcome) => void;
  /** Response sender pin — only this WebContents may acknowledge or answer. */
  webContentsId: number;
  cleanup: () => void;
  /** Re-push tick; cleared on receipt. Null once acknowledged. */
  resendTimer: ReturnType<typeof setInterval> | null;
  /** Deadline for the receipt; cleared on receipt. Null once acknowledged. */
  deliveryTimer: ReturnType<typeof setTimeout> | null;
  /** Five-minute decision clock; armed only once delivery is proven. */
  decisionTimer: ReturnType<typeof setTimeout> | null;
  acknowledged: boolean;
}

const pendingConsents = new Map<string, PendingConsent>();
let consentBridgeInstalled = false;

/** Pick the window that should host a capability consent prompt. */
function resolvePromptWindow(): BrowserWindow | null {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && !focused.isDestroyed()) return focused;
  const primary = getMainWindow();
  if (primary && !primary.isDestroyed()) return primary;
  return null;
}

/**
 * The single terminal path for a pending prompt. Drops the entry first so any
 * re-entrant or late event (a re-push tick, a destroy signal, a straggling
 * reply) becomes a no-op, then disarms every timer the entry owns — which of
 * the three are live depends on whether delivery was ever acknowledged.
 */
function settleConsent(requestId: string, outcome: PluginCapabilityConsentOutcome): void {
  const pending = pendingConsents.get(requestId);
  if (!pending) return;
  pendingConsents.delete(requestId);
  if (pending.resendTimer) clearInterval(pending.resendTimer);
  if (pending.deliveryTimer) clearTimeout(pending.deliveryTimer);
  if (pending.decisionTimer) clearTimeout(pending.decisionTimer);
  pending.cleanup();
  pending.resolve(outcome);
}

const consentBridge: PluginCapabilityConsentBridge = (request: PluginCapabilityConsentRequest) => {
  const win = resolvePromptWindow();
  // The app renderer is the window's registered WebContentsView, not the
  // BrowserWindow shell — see the note above (#11708).
  const wc = win ? getAppWebContents(win) : null;
  if (!wc || wc.isDestroyed()) {
    // Fail closed, but say so honestly: there is no surface to prompt on, which
    // is not the same as a user refusing.
    return Promise.resolve("undeliverable");
  }
  return new Promise<PluginCapabilityConsentOutcome>((resolve) => {
    const requestId = randomUUID();
    // A renderer that goes away can no longer show or answer the prompt. Before
    // acknowledgement that is a delivery failure; after it, the dialog the user
    // was looking at vanished — neither is a decision they made.
    const onDestroyed = () => settleConsent(requestId, "undeliverable");
    const cleanup = () => {
      try {
        wc.removeListener("destroyed", onDestroyed);
      } catch {
        // best-effort — the WebContents may already be torn down
      }
    };

    const push = () => {
      wc.send(CHANNELS.EVENTS_PUSH, {
        name: "plugin-capability:consent-request",
        payload: {
          requestId,
          pluginId: request.pluginId,
          pluginDisplayName: request.pluginDisplayName,
          capability: request.capability,
          declaredCapabilities: request.declaredCapabilities,
        },
      });
    };

    // Re-push the same prompt to the same renderer until it acknowledges. This
    // is what carries a prompt across a cold project switch: the app view is
    // registered before React mounts the consent listener, so the first push
    // can land in a renderer that is not listening yet. The renderer keys on
    // `requestId` and re-acknowledges rather than queueing a second dialog.
    const resendTimer = setInterval(() => {
      const pending = pendingConsents.get(requestId);
      if (!pending || pending.acknowledged) return;
      if (wc.isDestroyed()) {
        settleConsent(requestId, "undeliverable");
        return;
      }
      try {
        push();
      } catch {
        settleConsent(requestId, "undeliverable");
      }
    }, PLUGIN_CAPABILITY_CONSENT_RESEND_INTERVAL_MS);

    // No receipt in time: the prompt is not on screen anywhere, so fail now
    // rather than holding the plugin for the full five-minute decision window.
    const deliveryTimer = setTimeout(() => {
      console.warn(
        `[plugin-capability] No renderer acknowledged the consent prompt for plugin "${request.pluginId}" capability "${request.capability}" within ${PLUGIN_CAPABILITY_CONSENT_DELIVERY_TIMEOUT_MS}ms — treating it as undeliverable`
      );
      settleConsent(requestId, "undeliverable");
    }, PLUGIN_CAPABILITY_CONSENT_DELIVERY_TIMEOUT_MS);

    pendingConsents.set(requestId, {
      resolve,
      webContentsId: wc.id,
      cleanup,
      resendTimer,
      deliveryTimer,
      decisionTimer: null,
      acknowledged: false,
    });
    wc.once("destroyed", onDestroyed);
    try {
      push();
    } catch {
      settleConsent(requestId, "undeliverable");
    }
  });
};

/** Install the consent bridge once, lazily — keeps an unused boot path bridge-free. */
function ensureConsentBridge(): void {
  if (consentBridgeInstalled) return;
  consentBridgeInstalled = true;
  getPluginCapabilityConsentService().setConsentBridge(consentBridge);
}

/** Test-only: drop installed-bridge state and fail any pending prompts closed. */
export function _resetCapabilityConsentBridgeForTest(): void {
  for (const requestId of [...pendingConsents.keys()]) {
    settleConsent(requestId, "undeliverable");
  }
  // Detach from the service too, mirroring the disposer. Clearing only the flag
  // would leave the service holding a bridge that a later disposer then skips
  // detaching, because the flag says it was never installed.
  if (consentBridgeInstalled) {
    getPluginCapabilityConsentService().setConsentBridge(null);
  }
  consentBridgeInstalled = false;
}

/**
 * Renderer receipt for a `plugin-capability:consent-request` push (#11708).
 * Proves the prompt reached a renderer that can display it, which the push
 * itself cannot: `send()` into a listener-less document is a silent no-op.
 *
 * Stops the re-push loop and hands the request over to the five-minute decision
 * clock, which deliberately starts here rather than at push time — a prompt
 * that took two seconds to land should still get the full window to answer in.
 * Sender-pinned like the decision reply, and one-shot: duplicate receipts (the
 * renderer re-acknowledges a re-push it already holds) are no-ops rather than
 * re-arming the clock.
 */
export async function handleAcknowledgeConsent(
  ctx: IpcContext,
  input: PluginCapabilityAcknowledgeConsentInput
): Promise<void> {
  const pending = pendingConsents.get(input.requestId);
  if (!pending) return;
  if (ctx.webContentsId !== pending.webContentsId) {
    console.warn(
      `[plugin-capability] Ignoring consent receipt from unexpected sender ${ctx.webContentsId} (expected ${pending.webContentsId}, requestId=${input.requestId})`
    );
    return;
  }
  if (pending.acknowledged) return;
  pending.acknowledged = true;
  if (pending.resendTimer) {
    clearInterval(pending.resendTimer);
    pending.resendTimer = null;
  }
  if (pending.deliveryTimer) {
    clearTimeout(pending.deliveryTimer);
    pending.deliveryTimer = null;
  }
  // Safety net: an abandoned prompt settles itself as "timeout" so the gating
  // promise never hangs and the pending entry is freed (#10841).
  pending.decisionTimer = setTimeout(
    () => settleConsent(input.requestId, "timeout"),
    PLUGIN_CAPABILITY_CONSENT_TIMEOUT_MS
  );
}

/**
 * Renderer reply to a `plugin-capability:consent-request` push. The pending
 * consent is dropped (resolving the bridge promise) only when the responding
 * WebContents is the one the prompt was sent to — a sibling window cannot answer
 * another window's prompt.
 *
 * A decision arriving before the receipt is itself proof of delivery, so it
 * settles normally; `settleConsent` disarms the delivery and re-push timers
 * whether or not they were ever superseded.
 */
export async function handleResolveConsent(
  ctx: IpcContext,
  input: PluginCapabilityResolveConsentInput
): Promise<void> {
  const pending = pendingConsents.get(input.requestId);
  if (!pending) return;
  if (ctx.webContentsId !== pending.webContentsId) {
    console.warn(
      `[plugin-capability] Ignoring consent reply from unexpected sender ${ctx.webContentsId} (expected ${pending.webContentsId}, requestId=${input.requestId})`
    );
    return;
  }
  settleConsent(input.requestId, input.decision);
}

export const pluginCapabilityNamespace = defineIpcNamespace({
  name: "pluginCapability",
  ops: {
    resolveConsent: op(PLUGIN_CAPABILITY_METHOD_CHANNELS.resolveConsent, handleResolveConsent, {
      withContext: true,
    }),
    acknowledgeConsent: op(
      PLUGIN_CAPABILITY_METHOD_CHANNELS.acknowledgeConsent,
      handleAcknowledgeConsent,
      { withContext: true }
    ),
  },
});

export function registerPluginCapabilityHandlers(): () => void {
  ensureConsentBridge();
  const unregister = pluginCapabilityNamespace.register();
  return () => {
    unregister();
    // Tear down the consent bridge so a re-registration reinstalls cleanly and
    // no stale prompt resolves against a torn-down renderer. Pending prompts
    // fail closed rather than being left dangling — as "undeliverable", since
    // the surface was pulled out from under them and no user ever answered.
    if (consentBridgeInstalled) {
      getPluginCapabilityConsentService().setConsentBridge(null);
      consentBridgeInstalled = false;
    }
    for (const requestId of [...pendingConsents.keys()]) {
      settleConsent(requestId, "undeliverable");
    }
  };
}
