/**
 * Wire types for the site-preview bridge — the host-owned channel between a
 * dev-preview guest page and the Site Builder plugin.
 *
 * Structural only, and deliberately free of any `electron/` import: the zod
 * schemas that actually validate the envelope live in
 * `electron/services/sitePreview/guestProtocol.ts`, which asserts mutual
 * assignability against {@link SiteGuestDocumentReady} so the shape the two
 * halves share cannot drift.
 *
 * The envelope is host-owned and framework-neutral. Event *payloads* are not:
 * apart from the one lifecycle event the host interprets, a guest event crosses
 * this boundary as an opaque body carrying a `type`, and the adapter that
 * installed the runtime is what validates it. So a second framework adapter
 * needs no member here.
 */

export type SitePreviewMode = "browse" | "select";

export interface SiteGuestSourceLocation {
  file: string;
  line: number;
  column: number;
}

export interface SiteGuestAncestryEntry {
  type: string;
  file: string;
  line: number;
  column: number;
  componentTag?: string;
}

export interface SiteGuestRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SiteGuestViewport {
  width: number;
  height: number;
  deviceScaleFactor: number;
}

/**
 * One node as the guest saw it. Part of the SvelteKit adapter's own payload
 * vocabulary, not of the host envelope — the host neither validates nor reads
 * it; it is declared here only because the adapter's renderer half and the
 * panel surfaces share it. No file path, range or revision is trusted from
 * here: `loc` and `ancestry` are verbatim `__svelte_meta` readings, which a
 * hostile page can fabricate, and source identity is re-resolved from source.
 */
export interface SiteGuestNodeObservation {
  runtimeOccurrenceId: string;
  loc: SiteGuestSourceLocation | null;
  ancestry: SiteGuestAncestryEntry[];
  tagName: string;
  sameLocCount: number;
  /** The page stopped counting at its scan bound: `sameLocCount` is a floor. */
  sameLocCountPartial?: true;
  /** Which of those this node is, in document order; absent from older runtimes. */
  locIndex?: number;
  /**
   * Where the node sits in its template — outermost first, each step the tag
   * and the index among the elements at that level that share its frame — for
   * a page whose `loc` is a neighbour's. Absent from older runtimes.
   */
  structure?: { file: string; path: Array<{ tag: string; index: number }> };
  label: string;
  bounds: SiteGuestRect[];
  unmapped: boolean;
}

/**
 * The one guest event the host itself reads: it flips the binding's readiness.
 * Validated by the host, exactly, and by the adapter too — the one payload the
 * two halves share, so nothing may be added to it on one side alone.
 */
export type SiteGuestDocumentReady = {
  type: "documentReady";
  routeId: string | null;
  url: string;
  viewport: SiteGuestViewport;
};

/**
 * Any other guest event. The host validated the envelope around it and that it
 * carries a `type`; the body is data it never interpreted, so treat every field
 * as unproven until the adapter's own schema has parsed it.
 */
export type SiteGuestEnvelopeEvent = {
  type: string;
  [key: string]: unknown;
};

export type SiteGuestEvent = SiteGuestDocumentReady | SiteGuestEnvelopeEvent;

/** A dev-preview panel this project could bind to. */
export interface SitePreviewCandidate {
  panelId: string;
  /** The guest's current URL, or null when nothing is loaded. */
  url: string | null;
  /** Non-null when this bridge already holds a binding on that panel. */
  boundSessionId: string | null;
}

export interface SitePreviewBindingState {
  /** Host-issued. Scopes guest traffic to one binding; it authorises nothing. */
  sessionId: string;
  panelId: string;
  projectId: string;
  documentEpoch: number;
  mode: SitePreviewMode;
  /** True once the guest runtime reported `documentReady` for this epoch. */
  guestReady: boolean;
  /** Envelopes rejected by validation since the binding opened. */
  droppedMessages: number;
  /**
   * True while the preview shows a document outside the adapter's origin
   * policy. The binding is kept, nothing is installed, and the next document
   * back inside the policy installs normally.
   */
  suspended: boolean;
}

export type SitePreviewDetachReason =
  | "requested"
  | "guest-destroyed"
  | "rebound"
  | "install-failed"
  /** The CDP transport went away while the guest was still alive. */
  | "debugger-detached"
  /** Sustained invalid traffic; the transport was removed to stop the flood. */
  | "guest-flooding"
  | "host-shutdown";

export type SitePreviewPushPayload =
  | {
      kind: "guest-event";
      sessionId: string;
      panelId: string;
      projectId: string;
      documentEpoch: number;
      sequence: number;
      event: SiteGuestEvent;
    }
  | { kind: "epoch-advanced"; sessionId: string; projectId: string; documentEpoch: number }
  /**
   * The preview navigated across the adapter's origin policy: `suspended` is
   * true when the document it now shows is outside it and the runtime was
   * withheld, false once a later document is back inside and installed.
   */
  | {
      kind: "origin-policy";
      sessionId: string;
      projectId: string;
      documentEpoch: number;
      suspended: boolean;
    }
  | {
      kind: "detached";
      sessionId: string;
      projectId: string;
      reason: SitePreviewDetachReason;
    };

export interface SitePreviewBindRequest {
  panelId: string;
  /**
   * Which host-registered guest runtime to install. The caller names it; main
   * loads the body. A caller never supplies script — there is no "evaluate this
   * in the guest" operation either, by design.
   */
  adapterId: string;
  mode?: SitePreviewMode;
}
