import type { HostId } from "../remoteHosts.js";

export interface PortForward {
  forwardId: string;
  hostId: HostId;
  remotePort: number;
  localPort: number;
  /** Why it exists: a dev preview, a CLI login callback, or the user's Forward port… */
  origin: "dev-preview" | "oauth-callback" | "manual" | "detected";
  label: string | null;
  createdAt: number;
}

export interface ForwardPortPayload {
  hostId: HostId;
  remotePort: number;
  origin?: PortForward["origin"];
  label?: string;
}

export interface HostListeningPort {
  port: number;
  processName: string | null;
  pid: number | null;
}

export type PortForwardsEvent = { type: "changed"; forwards: PortForward[] };
