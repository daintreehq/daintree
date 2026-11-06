/**
 * The scripts the host evaluates for the core Element Picker. Every body comes
 * from the app's own asset catalog (`guestAssets.ts`), never from a renderer
 * or a page; the only other values interpolated are host-minted ids, the
 * channel, a validated mode and a framework from the shared enum, each through
 * `JSON.stringify` so none can close the literal it lands in.
 *
 * Two worlds, two kinds of guard:
 *
 * - The bootstrap runs in the picker's isolated world. The CDP binding is
 *   scoped to that world by name, so a bootstrap prelude that finds no binding
 *   knows the evaluate landed somewhere else and does nothing.
 * - The probe and the extractors run in the page's main world, where the host
 *   cannot name a document, only "whatever the main frame shows now". Their
 *   preludes first dispatch a cancelable handshake that only this install's
 *   bootstrap cancels: in a document a navigation swapped in under the evaluate
 *   there is no such bootstrap, so nothing installs there.
 */

import type { SitePreviewMode } from "../../../shared/types/ipc/sitePreview.js";
import type {
  ElementPickerFramework,
  ElementPickerProviderId,
} from "../../../shared/elementPicker/source.js";
import {
  ELEMENT_PICKER_PROTOCOL_VERSION,
  MAX_ELEMENT_PICKER_MESSAGE_BYTES,
} from "../../../shared/elementPicker/protocol.js";
import { buildOriginGuardSource, type GuestOriginPolicy } from "../sitePreview/originPolicy.js";
import {
  BOOTSTRAP_GLOBAL,
  EXTRACTOR_INSTALL_STATUS,
  EXTRACTOR_REGISTRY_GLOBAL,
  channelEvent,
} from "./guestChannel.js";
import type { ProviderProbe } from "./guest/providerDetection.js";
import type { PickerAvailability } from "./guest/types.js";

/**
 * Fixed, unlike the per-install channel: a newer bootstrap must reach every
 * older one in the document whatever channel it was given. Page script can
 * send it too, and the most that buys is retiring the picker in its own page.
 */
export const SUPERSEDE_EVENT = "daintree-element-picker:supersede";

export interface BootstrapSourceParams {
  sessionId: string;
  /** Strictly increasing across every install, so the newer bootstrap in a world always wins. */
  installId: number;
  documentEpoch: number;
  bindingName: string;
  channel: string;
  mode: SitePreviewMode;
  origins: GuestOriginPolicy;
  body: string;
}

/**
 * Bookkeeping, not a boundary, for everything except one thing: this runs in
 * a world page script cannot reach, so the page cannot replace `post`, read
 * the binding or advance the sequence. What
 * the bootstrap reports about the page is still the page's to shape, which is
 * why the host validates every envelope as untrusted.
 */
export function buildBootstrapSource(params: BootstrapSourceParams): string {
  const { sessionId, installId, documentEpoch, bindingName, channel, mode, origins, body } = params;
  return `(() => {
  // The host checked the policy before creating the world, but a navigation
  // can commit between that check and this evaluate.
  if (!${buildOriginGuardSource(origins)}) return;
  const g = globalThis;
  const send = g[${JSON.stringify(bindingName)}];
  if (typeof send !== "function") return;
  const KEY = ${JSON.stringify(BOOTSTRAP_GLOBAL)};
  const SUPERSEDE = ${JSON.stringify(SUPERSEDE_EVENT)};
  const INSTALL_ID = ${installId};
  const previous = g[KEY];
  // A world outlives a reinstall into the same document; the newer install wins.
  if (previous && typeof previous.installId === "number" && previous.installId >= INSTALL_ID) return;
  // An older picker in another world cannot be reached through this world's
  // global — a rebind makes a new world, a debugger session that came back
  // gets one of its own — so it is told through the DOM, which both share.
  // Without this, one whose disposal never arrived would go on swallowing the
  // page's clicks under its successor.
  try { document.dispatchEvent(new CustomEvent(SUPERSEDE, { detail: String(INSTALL_ID) })); } catch {}
  if (previous && typeof previous.retire === "function") {
    try { previous.retire(); } catch { /* a torn-down bootstrap must not block its replacement */ }
  }
  let retired = false;
  const onSupersede = (event) => {
    const by = Number(event.detail);
    if (Number.isSafeInteger(by) && by > INSTALL_ID) retire();
  };
  function retire() {
    if (retired) return;
    retired = true;
    document.removeEventListener(SUPERSEDE, onSupersede);
    try { if (typeof api.dispose === "function") api.dispose(); } catch {}
    if (g[KEY] === api) {
      try { delete g[KEY]; } catch { g[KEY] = undefined; }
    }
  }
  const VERSION = ${ELEMENT_PICKER_PROTOCOL_VERSION};
  const SESSION_ID = ${JSON.stringify(sessionId)};
  const DOCUMENT_EPOCH = ${documentEpoch};
  const MAX_BYTES = ${MAX_ELEMENT_PICKER_MESSAGE_BYTES};
  let sequence = 0;
  const envelope = (event) => JSON.stringify({
    protocolVersion: VERSION,
    sessionId: SESSION_ID,
    documentEpoch: DOCUMENT_EPOCH,
    sequence,
    event,
  });
  const api = {
    installId: INSTALL_ID,
    channel: ${JSON.stringify(channel)},
    mode: ${JSON.stringify(mode)},
    setMode(next) { api.mode = next; },
    clearSelection() {},
    clearHover() {},
    setAvailability() {},
    reselect() { return false; },
    dispose: null,
    retire,
    post(event) {
      let text;
      try { text = envelope(event); } catch { return; }
      // Code units are a floor on UTF-8 bytes; a message the host would refuse
      // unread is replaced by one saying so.
      if (text.length > MAX_BYTES || new TextEncoder().encode(text).length > MAX_BYTES) {
        text = envelope({ type: "runtimeIssue", code: "capacity", detail: "an observation exceeded the message ceiling" });
      }
      sequence += 1;
      try { send(text); } catch { /* the host treats silence as no observation */ }
    },
  };
  g[KEY] = api;
  document.addEventListener(SUPERSEDE, onSupersede);
  try {
${body}
  } catch (err) {
    api.post({ type: "runtimeIssue", code: "internal", detail: String(err && err.message ? err.message : err).slice(0, 512) });
  }
})();`;
}

function handshakeSource(channel: string, absent: string): string {
  return `const handshake = new CustomEvent(${JSON.stringify(channelEvent(channel, "handshake"))}, { cancelable: true });
  try { document.dispatchEvent(handshake); } catch { return ${absent}; }
  if (!handshake.defaultPrevented) return ${absent};`;
}

/** Evaluates, by value, to the probe's detections — or null when this install's bootstrap is not in the document. */
export function buildProbeSource(params: {
  channel: string;
  body: string;
  /** Registered plugin providers' ids and declared rules; data the probe compares names against. */
  providers?: readonly ProviderProbe[];
}): string {
  return `(() => {
  ${handshakeSource(params.channel, "null")}
  const api = { result: null, providers: ${JSON.stringify(params.providers ?? [])} };
  try {
${params.body}
  } catch { return null; }
  return api.result;
})()`;
}

/**
 * Evaluates, by value, to one of {@link EXTRACTOR_INSTALL_STATUS}. `served`,
 * the markup the dev server sent for this document, goes in as data for an
 * extractor that reads it: through `JSON.stringify`, like everything else here.
 */
export function buildExtractorSource(params: {
  channel: string;
  framework: ElementPickerFramework;
  body: string;
  served?: { url: string; html: string } | null;
}): string {
  const status = EXTRACTOR_INSTALL_STATUS;
  const served = params.served === undefined ? "" : `, served: ${JSON.stringify(params.served)}`;
  return `(() => {
  ${handshakeSource(params.channel, JSON.stringify(status.absent))}
  const api = { channel: ${JSON.stringify(params.channel)}, framework: ${JSON.stringify(params.framework)}, installed: false${served} };
  try {
${params.body}
  } catch { return ${JSON.stringify(status.threw)}; }
  return api.installed === true ? ${JSON.stringify(status.installed)} : ${JSON.stringify(status.unregistered)};
})()`;
}

/**
 * An installed plugin's extractor. `runtime` is the host's own registration
 * asset (it defines `api.register`); `body` is the plugin's standalone entry,
 * run in a function of its own so its bindings stay out of the prelude. The
 * entry's default export is a factory the host calls with the provider id; the
 * id was read from the registry and goes in through `JSON.stringify`, so it
 * cannot close the literal. Evaluates to one of {@link EXTRACTOR_INSTALL_STATUS}.
 */
export function buildPluginExtractorSource(params: {
  channel: string;
  providerId: ElementPickerProviderId;
  runtime: string;
  body: string;
}): string {
  const status = EXTRACTOR_INSTALL_STATUS;
  const providerId = JSON.stringify(params.providerId);
  return `(() => {
  ${handshakeSource(params.channel, JSON.stringify(status.absent))}
  const api = { channel: ${JSON.stringify(params.channel)}, framework: ${providerId}, installed: false };
  try {
${params.runtime}
    const entry = (() => {
${params.body}
      return typeof __daintreeExtractor === "undefined" ? undefined : __daintreeExtractor;
    })();
    const make = typeof entry === "function" ? entry : entry && entry.default;
    if (typeof make === "function") {
      const extractor = make(${providerId});
      if (extractor && typeof extractor.extract === "function") api.register(extractor);
    }
  } catch { return ${JSON.stringify(status.threw)}; }
  return api.installed === true ? ${JSON.stringify(status.installed)} : ${JSON.stringify(status.unregistered)};
})()`;
}

/**
 * Takes one provider's extractor out of the document's registry, running its
 * cleanup; the others keep answering. Matched on the channel, so it can only
 * reach the registry this install made.
 */
export function buildExtractorRemoveSource(
  channel: string,
  providerId: ElementPickerProviderId
): string {
  return `(() => {
  ${handshakeSource(channel, "false")}
  const registry = globalThis[${JSON.stringify(EXTRACTOR_REGISTRY_GLOBAL)}];
  if (!registry || registry.channel !== ${JSON.stringify(channel)} || typeof registry.unregister !== "function") return false;
  try { registry.unregister(${JSON.stringify(providerId)}); } catch { return false; }
  return true;
})()`;
}

/**
 * A host-authored call on the bootstrap, matched on install id so a poke can
 * never reach a bootstrap some later install put there.
 */
function bootstrapCall(installId: number, call: string): string {
  return `(() => {
  const api = globalThis[${JSON.stringify(BOOTSTRAP_GLOBAL)}];
  if (!api || api.installId !== ${installId}) return;
  try { ${call} } catch {}
})();`;
}

export function buildPickerModeSource(installId: number, mode: SitePreviewMode): string {
  return bootstrapCall(installId, `api.setMode(${JSON.stringify(mode)});`);
}

export function buildPickerClearSelectionSource(installId: number): string {
  return bootstrapCall(installId, "api.clearSelection();");
}

export function buildPickerClearHoverSource(installId: number): string {
  return bootstrapCall(installId, "api.clearHover();");
}

/**
 * The host's account of the document's readers. Host-authored from its own
 * state — the framework enum and fixed state words — so nothing the page said
 * reaches the literal.
 */
export function buildPickerAvailabilitySource(
  installId: number,
  availability: PickerAvailability
): string {
  return bootstrapCall(installId, `api.setAvailability(${JSON.stringify(availability)});`);
}

/**
 * Asks the bootstrap to select again what the host had selected. Evaluates, by
 * value, to whether it did; false for a bootstrap some later install replaced.
 * The request is data for the guest to validate: an element id, a framework
 * locator or component id, built from an observation the host admitted.
 */
export function buildPickerReselectSource(
  installId: number,
  request: {
    elementId?: string;
    framework?: ElementPickerProviderId;
    locator?: unknown;
    componentId?: string;
    reveal?: boolean;
  }
): string {
  return `(() => {
  const api = globalThis[${JSON.stringify(BOOTSTRAP_GLOBAL)}];
  if (!api || api.installId !== ${installId}) return false;
  try { return api.reselect(${JSON.stringify(request)}) === true; } catch { return false; }
})()`;
}

/** Retires the bootstrap, which tells the main-world extractors installed for it to go too. */
export function buildPickerDisposeSource(installId: number): string {
  return bootstrapCall(installId, "api.retire();");
}
