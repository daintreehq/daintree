import type { HostId } from "../remoteHosts.js";

export interface PortForward {
  forwardId: string;
  hostId: HostId;
  remotePort: number;
  localPort: number;
  /**
   * Why it exists: a dev preview, a CLI login callback (or a page opened in
   * the system browser, which closes the same way once idle), the user's
   * Forward port…, or a browser panel showing the host's page.
   */
  origin: "dev-preview" | "oauth-callback" | "manual" | "detected" | "browser-panel";
  label: string | null;
  createdAt: number;
}

export interface ForwardPortPayload {
  hostId: HostId;
  remotePort: number;
  origin?: PortForward["origin"];
  label?: string;
  /**
   * The browser panel asking, in the calling view: the forward is kept while
   * any panel holds it and released with the last. Required for
   * `browser-panel`.
   */
  panelId?: string;
  /** Refuse rather than forward to another local port when this one is taken here. */
  samePort?: boolean;
}

export interface ReleasePortForwardsPayload {
  panelId: string;
}

export interface HostListeningPort {
  port: number;
  processName: string | null;
  pid: number | null;
}

export type PortForwardsEvent = { type: "changed"; forwards: PortForward[] };
