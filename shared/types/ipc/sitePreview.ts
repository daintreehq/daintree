/**
 * Wire types for the site-preview bridge — the host-owned binding between a
 * dev-preview guest page and the Element Picker. The picker's own events live
 * in `shared/elementPicker/protocol.ts`; these are the bridge's lifecycle.
 */

export type SitePreviewMode = "browse" | "select";

export interface SitePreviewBindingState {
  /** Host-issued. Scopes guest traffic to one binding; it authorises nothing. */
  sessionId: string;
  panelId: string;
  projectId: string;
  documentEpoch: number;
  mode: SitePreviewMode;
  /** True once the guest reported `documentReady` for this epoch. */
  guestReady: boolean;
  /** Envelopes rejected by validation since the binding opened. */
  droppedMessages: number;
  /**
   * True while the preview shows a document outside the origin policy. The
   * binding is kept, nothing is installed, and the next document back inside
   * the policy installs normally.
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
  /**
   * The view that established the binding went away. Observations are addressed
   * to that view alone, so the binding has no consumer left; nobody receives
   * this one, and it exists so the teardown path can say what happened.
   */
  | "subscriber-destroyed"
  | "host-shutdown";

/** The bridge's own lifecycle events for a binding, delivered with the picker's. */
export type SitePreviewPushPayload =
  | { kind: "epoch-advanced"; sessionId: string; projectId: string; documentEpoch: number }
  /**
   * The preview navigated across the origin policy: `suspended` is true when
   * the document it now shows is outside it and the runtime was withheld,
   * false once a later document is back inside and installed.
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
