export type HostModeCheckState = "ok" | "warning" | "unavailable" | "unknown";

export interface HostModeStatusRow {
  id: "socket" | "start-at-login" | "keychain" | "sleep" | "drivers";
  state: HostModeCheckState;
  /** What we observed, stated plainly. */
  detail: string;
  /** A command the user can run themselves to fix it, if any. */
  command?: string;
}

export interface AttachedClientInfo {
  clientId: string;
  clientName: string;
  connectedAt: number;
  /** Projects this client currently drives. */
  drivingProjectIds: string[];
}

export interface HostModeStatus {
  supported: boolean;
  enabled: boolean;
  startAtLogin: boolean;
  socketPath: string | null;
  listening: boolean;
  attachedClients: AttachedClientInfo[];
  rows: HostModeStatusRow[];
}

export interface SetHostModePayload {
  enabled: boolean;
  startAtLogin?: boolean;
}

export type HostModeEvent = { type: "status-changed"; status: HostModeStatus };
