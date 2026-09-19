/**
 * The guest runtime exactly as the host installs it.
 *
 * `scripts/build-main.mjs` bundles this entry — named by `contributes.guestAdapters`
 * in `plugin.json` — into a standalone IIFE under the plugin's `guest/` output
 * directory, at a path derived from the adapter id, and the host's
 * `daintree.sveltekit-builder.guest` adapter reads that file back as text. Nothing in the renderer imports it: the runtime used to travel as
 * `Function.prototype.toString()` output, which forced the whole factory into
 * one closure and broke on any transform that hoisted a helper out of it.
 *
 * The host prelude (`electron/services/sitePreview/guestRuntime.ts`) splices
 * this asset into a scope where it has already declared `api`, so `api` is a
 * free identifier here and must stay one — declaring it would shadow the
 * prelude's and route around the envelope numbering the prelude owns. Reading
 * the CDP binding directly would do the same.
 */

import { GUEST_HANDLE_NAME } from "./names.js";
import { createSiteBuilderGuest } from "./runtime.js";
import type { GuestMode, GuestRuntimeHandle, GuestSourceLoc } from "./types.js";

/** The half of the prelude's `api` this asset reads or replaces. */
interface GuestHostApi {
  protocolVersion: number;
  sessionId: string;
  documentEpoch: number;
  mode: GuestMode;
  post(event: unknown): void;
  setMode(mode: GuestMode): void;
  reselect(
    loc: GuestSourceLoc,
    index?: number,
    component?: GuestSourceLoc | null,
    occurrence?: string | null
  ): boolean;
  clearSelection(): void;
  clearHover(): void;
  dispose: (() => void) | null;
  guest?: GuestRuntimeHandle;
}

declare const api: GuestHostApi;

const guest = createSiteBuilderGuest(
  {
    protocolVersion: api.protocolVersion,
    sessionId: api.sessionId,
    documentEpoch: api.documentEpoch,
    mode: api.mode,
    // Empty on purpose: observations leave through the prelude's `post`, which
    // addresses and numbers the envelope.
    bindingName: "",
    handleName: GUEST_HANDLE_NAME,
  },
  { post: (event) => api.post(event) }
);

// Captured before it is replaced, and called bare — the prelude's `setMode`
// closes over `api` rather than using its receiver.
const hostSetMode = api.setMode;
api.setMode = (next) => {
  hostSetMode(next);
  guest.setMode(next);
};
api.reselect = (loc, index, component, occurrence) =>
  guest.reselect(loc, index, component, occurrence);
api.clearSelection = () => guest.clearSelection();
api.clearHover = () => guest.clearHover();
api.dispose = () => guest.dispose();
api.guest = guest;
