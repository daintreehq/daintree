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
import type {
  PluginCapabilityConsentDecision,
  PluginCapabilityResolveConsentInput,
} from "../../../shared/types/pluginCapabilityConsent.js";

// --- Consent bridge (main → renderer prompt, renderer → main decision) --------
//
// `PluginCapabilityConsentService.ensureAllowed` blocks on an injected bridge
// when a first-use prompt is required. Unlike the plugin-MCP consent bridge,
// the gated call originates in the plugin's own utility process — there is no
// initiating renderer to pin to — so the prompt is sent to the focused window,
// falling back to the primary window. The renderer replies via
// `plugin-capability:resolve-consent`, correlated by `requestId`.

interface PendingConsent {
  resolve: (decision: PluginCapabilityConsentDecision) => void;
  webContentsId: number;
  cleanup: () => void;
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

function settleConsent(requestId: string, decision: PluginCapabilityConsentDecision): void {
  const pending = pendingConsents.get(requestId);
  if (!pending) return;
  pendingConsents.delete(requestId);
  pending.cleanup();
  pending.resolve(decision);
}

const consentBridge: PluginCapabilityConsentBridge = (request: PluginCapabilityConsentRequest) => {
  const win = resolvePromptWindow();
  const wc = win?.webContents;
  if (!wc || wc.isDestroyed()) {
    // Fail closed: no window to surface a prompt, so no one can approve.
    return Promise.resolve("rejected");
  }
  return new Promise<PluginCapabilityConsentDecision>((resolve) => {
    const requestId = randomUUID();
    const onDestroyed = () => settleConsent(requestId, "rejected");
    const cleanup = () => {
      try {
        wc.removeListener("destroyed", onDestroyed);
      } catch {
        // best-effort — the WebContents may already be torn down
      }
    };
    pendingConsents.set(requestId, { resolve, webContentsId: wc.id, cleanup });
    wc.once("destroyed", onDestroyed);
    try {
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
    } catch {
      settleConsent(requestId, "rejected");
    }
  });
};

/** Install the consent bridge once, lazily — keeps an unused boot path bridge-free. */
function ensureConsentBridge(): void {
  if (consentBridgeInstalled) return;
  consentBridgeInstalled = true;
  getPluginCapabilityConsentService().setConsentBridge(consentBridge);
}

/** Test-only: drop installed-bridge state and reject any pending prompts. */
export function _resetCapabilityConsentBridgeForTest(): void {
  for (const requestId of [...pendingConsents.keys()]) {
    settleConsent(requestId, "rejected");
  }
  consentBridgeInstalled = false;
}

/**
 * Renderer reply to a `plugin-capability:consent-request` push. The pending
 * consent is dropped (resolving the bridge promise) only when the responding
 * WebContents is the one the prompt was sent to — a sibling window cannot answer
 * another window's prompt.
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
  },
});

export function registerPluginCapabilityHandlers(): () => void {
  ensureConsentBridge();
  const unregister = pluginCapabilityNamespace.register();
  return () => {
    unregister();
    // Tear down the consent bridge so a re-registration reinstalls cleanly and
    // no stale prompt resolves against a torn-down renderer. Pending prompts are
    // rejected (fail closed) rather than left dangling.
    if (consentBridgeInstalled) {
      getPluginCapabilityConsentService().setConsentBridge(null);
      consentBridgeInstalled = false;
    }
    for (const requestId of [...pendingConsents.keys()]) {
      settleConsent(requestId, "rejected");
    }
  };
}
