/**
 * Builds the script the host installs into a dev-preview guest.
 *
 * What the boundary here is, precisely: the body comes from a guest adapter
 * main registered at startup (`guestAdapters.ts`), never from the renderer —
 * the caller names an adapter and the host reads its asset. The only other
 * expressions evaluated are the fixed mode poke and disposer below, whose
 * interpolated values are a validated enum member and a host-generated number.
 * The host does NOT vet the body — it cannot, it is code — so this is a bound on
 * *who chooses* what reaches the page, not a claim that the script is safe. A
 * general "evaluate in the guest" IPC method would remove that bound and hand
 * any renderer-side caller a standing arbitrary-execution channel into whatever
 * site the user is previewing.
 */

import type { SitePreviewMode } from "../../../shared/types/ipc/sitePreview.js";
import { GUEST_PROTOCOL_VERSION } from "./guestProtocol.js";
import { buildOriginGuardSource, type GuestOriginPolicy } from "./originPolicy.js";

export const GUEST_RUNTIME_GLOBAL = "__daintreeSitePreview";

export interface GuestRuntimeParams {
  sessionId: string;
  /**
   * Strictly increasing across every install the host performs, so a later
   * runtime always supersedes an earlier one. The epoch cannot do this job: a
   * rebind restarts it at 0, and the outgoing runtime would then win.
   */
  installId: number;
  documentEpoch: number;
  bindingName: string;
  mode: SitePreviewMode;
  /** The adapter body, already resolved host-side. */
  runtimeSource: string;
  /** Where the adapter said it may run, checked by the script itself. */
  origins: GuestOriginPolicy;
}

/**
 * The prelude numbers and addresses the envelope for an honest runtime: the
 * session id and epoch are baked in per install and the sequence is counted
 * here, which is why the host reinstalls on every document rather than letting
 * the guest advance its own epoch.
 *
 * This is bookkeeping, not a security boundary. Everything below runs in the
 * page's main world, so a hostile page can replace `api.post`, call the binding
 * directly, or — if it controls the supplied body — assign `sequence`, and in
 * all three cases submit fabricated observations for this binding at a sequence
 * it chooses. What it cannot do is reach another binding, another project, or
 * anything the host does with a path: the host re-validates session and epoch,
 * and treats every accepted message as an untrusted observation.
 *
 * `JSON.stringify` on each interpolated value is what keeps a hostile panel id
 * or session id from closing the string literal it lands in.
 *
 * Nothing here can be hidden from the page: it runs in the main world, so a
 * hostile document can read the binding name, overwrite the global, or park a
 * fake `installId` high enough that the real runtime declines to install. All of
 * those are self-denial — the page silences its own inspector. None of them
 * reach another document, another binding or the host's own state, which is why
 * the validation that matters lives on the host side of the binding.
 */
export function buildGuestRuntimeSource(params: GuestRuntimeParams): string {
  const { sessionId, installId, documentEpoch, bindingName, mode, runtimeSource, origins } = params;
  return `(() => {
  // First statement in the script, before the global, the listeners and the
  // adapter body. The host checks the policy too, but it cannot check it in
  // time: this script is registered with \`Page.addScriptToEvaluateOnNewDocument\`
  // and has already run in the new document by the time main observes the
  // navigation, so a redirect to an authentication page or an external link
  // would have had the runtime in it for the moment before cleanup. The host's
  // check is what removes the registration and disposes the runtime; this one
  // is what keeps it from ever being there.
  if (!${buildOriginGuardSource(origins)}) return;
  const VERSION = ${GUEST_PROTOCOL_VERSION};
  const SESSION_ID = ${JSON.stringify(sessionId)};
  const INSTALL_ID = ${installId};
  const DOCUMENT_EPOCH = ${documentEpoch};
  const BINDING = ${JSON.stringify(bindingName)};
  const GLOBAL_KEY = ${JSON.stringify(GUEST_RUNTIME_GLOBAL)};
  const g = globalThis;
  const previous = g[GLOBAL_KEY];
  // A document can briefly run both the outgoing new-document script and the
  // reinstalled one. The newer install wins; the other bails without touching
  // the global it does not own.
  if (previous && typeof previous.installId === "number" && previous.installId > INSTALL_ID) return;
  if (previous && previous.installId === INSTALL_ID) return;
  if (previous && typeof previous.dispose === "function") {
    try { previous.dispose(); } catch { /* a torn-down runtime must not block its replacement */ }
  }
  let sequence = 0;
  const api = {
    protocolVersion: VERSION,
    installId: INSTALL_ID,
    sessionId: SESSION_ID,
    documentEpoch: DOCUMENT_EPOCH,
    mode: ${JSON.stringify(mode)},
    setMode(next) { api.mode = next; },
    reselect() { return false; },
    clearSelection() {},
    dispose: null,
    post(event) {
      const send = g[BINDING];
      if (typeof send !== "function") return;
      try {
        send(JSON.stringify({
          protocolVersion: VERSION,
          sessionId: SESSION_ID,
          documentEpoch: DOCUMENT_EPOCH,
          sequence: sequence++,
          event,
        }));
      } catch { /* the host treats silence as "no observation", which is correct */ }
    },
  };
  g[GLOBAL_KEY] = api;
  try {
${runtimeSource}
  } catch (err) {
    api.post({ type: "runtimeIssue", code: "internal", detail: String(err && err.message ? err.message : err).slice(0, 512) });
  }
})();`;
}

/**
 * Host-authored, fixed apart from the mode enum. Kept separate from
 * {@link buildGuestRuntimeSource} so it is obvious at the call site that
 * nothing caller-supplied reaches this string.
 */
export function buildModeUpdateSource(mode: SitePreviewMode): string {
  return `(() => {
  const api = globalThis[${JSON.stringify(GUEST_RUNTIME_GLOBAL)}];
  if (api && typeof api.setMode === "function") api.setMode(${JSON.stringify(mode)});
})();`;
}

/**
 * Ask the runtime to select the element compiled from `loc`. Host-authored,
 * with one validated object interpolated — the handler bounds the strings and
 * the numbers before they get here. Evaluates to `true` only when the runtime
 * found and selected an element; anything else, including a missing runtime,
 * reads as "not found" and the host keeps its safeguards.
 */
export function buildReselectSource(
  loc: { file: string; line: number; column: number },
  index: number,
  component: { file: string; line: number; column: number } | null = null,
  occurrence: string | null = null
): string {
  return `(() => {
  const api = globalThis[${JSON.stringify(GUEST_RUNTIME_GLOBAL)}];
  return api && typeof api.reselect === "function" ? api.reselect(${JSON.stringify(loc)}, ${JSON.stringify(index)}, ${JSON.stringify(component)}, ${JSON.stringify(occurrence)}) === true : false;
})();`;
}

/** Drop the guest's selection and overlay; observes nothing. Host-authored, fixed. */
export function buildClearSelectionSource(): string {
  return `(() => {
  const api = globalThis[${JSON.stringify(GUEST_RUNTIME_GLOBAL)}];
  if (api && typeof api.clearSelection === "function") api.clearSelection();
})();`;
}

/**
 * Best-effort teardown inside the guest. Only disposes the runtime this host
 * installed — matching on `installId` keeps a detach from killing a newer
 * runtime that already took the global.
 */
export function buildDisposeSource(installId: number): string {
  return `(() => {
  const KEY = ${JSON.stringify(GUEST_RUNTIME_GLOBAL)};
  const api = globalThis[KEY];
  if (!api || api.installId !== ${installId}) return;
  try { if (typeof api.dispose === "function") api.dispose(); } catch {}
  try { delete globalThis[KEY]; } catch { globalThis[KEY] = undefined; }
})();`;
}
