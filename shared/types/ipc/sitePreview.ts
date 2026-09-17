/**
 * Wire types for the site-preview bridge — the host-owned channel between a
 * dev-preview guest page and the Site Builder plugin.
 *
 * Structural only, and deliberately free of any `electron/` import: the zod
 * schemas that actually validate guest traffic live in
 * `electron/services/sitePreview/guestProtocol.ts`, which asserts mutual
 * assignability against {@link SiteGuestEvent} so the two cannot drift.
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
 * One node as the guest saw it. No file path, range or revision is trusted from
 * here — the host re-resolves source identity itself. `loc` and `ancestry` are
 * verbatim `__svelte_meta` readings, which a hostile page can fabricate.
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

export type SiteGuestEvent =
  | {
      type: "documentReady";
      routeId: string | null;
      url: string;
      viewport: SiteGuestViewport;
    }
  | {
      type: "selectionChanged";
      nodes: SiteGuestNodeObservation[];
      /** Who moved it; absent from older runtimes. */
      cause?: "user" | "document" | "reselect";
      scope?: "component";
      component?: {
        file: string;
        line: number;
        column: number;
        name: string;
      };
    }
  | { type: "hoverChanged"; node: SiteGuestNodeObservation | null }
  | { type: "mappingRevisionSeen"; revision: string }
  | {
      type: "runtimeIssue";
      code: "no-svelte-meta" | "not-dev-build" | "overlay-blocked" | "internal";
      detail: string;
    }
  /** What the page's Svelte dev metadata supports, probed once per document. */
  | { type: "metadataProbed"; locations: boolean; ancestry: boolean };

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
