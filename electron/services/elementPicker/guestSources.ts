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
import type { ElementPickerFramework } from "../../../shared/elementPicker/source.js";
import {
  ELEMENT_PICKER_PROTOCOL_VERSION,
  MAX_ELEMENT_PICKER_MESSAGE_BYTES,
} from "../../../shared/elementPicker/protocol.js";
import { buildOriginGuardSource, type GuestOriginPolicy } from "../sitePreview/originPolicy.js";
import { BOOTSTRAP_GLOBAL, EXTRACTOR_INSTALL_STATUS, channelEvent } from "./guestChannel.js";

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
 * a world page script cannot reach, so unlike the plugin runtime's prelude the
 * page cannot replace `post`, read the binding or advance the sequence. What
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
  const INSTALL_ID = ${installId};
  const previous = g[KEY];
  // A world outlives a reinstall into the same document; the newer install wins.
  if (previous && typeof previous.installId === "number" && previous.installId >= INSTALL_ID) return;
  if (previous && typeof previous.dispose === "function") {
    try { previous.dispose(); } catch { /* a torn-down bootstrap must not block its replacement */ }
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
    refresh() {},
    dispose: null,
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
export function buildProbeSource(params: { channel: string; body: string }): string {
  return `(() => {
  ${handshakeSource(params.channel, "null")}
  const api = { result: null };
  try {
${params.body}
  } catch { return null; }
  return api.result;
})()`;
}

/** Evaluates, by value, to one of {@link EXTRACTOR_INSTALL_STATUS}. */
export function buildExtractorSource(params: {
  channel: string;
  framework: ElementPickerFramework;
  body: string;
}): string {
  const status = EXTRACTOR_INSTALL_STATUS;
  return `(() => {
  ${handshakeSource(params.channel, JSON.stringify(status.absent))}
  const api = { channel: ${JSON.stringify(params.channel)}, framework: ${JSON.stringify(params.framework)}, installed: false };
  try {
${params.body}
  } catch { return ${JSON.stringify(status.threw)}; }
  return api.installed === true ? ${JSON.stringify(status.installed)} : ${JSON.stringify(status.unregistered)};
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

export function buildPickerRefreshSource(installId: number): string {
  return bootstrapCall(installId, "api.refresh();");
}

/** Disposes the bootstrap, which tells the main-world extractors installed for it to go too. */
export function buildPickerDisposeSource(installId: number): string {
  return `(() => {
  const KEY = ${JSON.stringify(BOOTSTRAP_GLOBAL)};
  const api = globalThis[KEY];
  if (!api || api.installId !== ${installId}) return;
  try { if (typeof api.dispose === "function") api.dispose(); } catch {}
  try { delete globalThis[KEY]; } catch { globalThis[KEY] = undefined; }
})();`;
}
