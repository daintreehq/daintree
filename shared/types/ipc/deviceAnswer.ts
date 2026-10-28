/** A device paired to answer this machine's agents, as kept on disk. */
export interface PairedDeviceRecord {
  id: string;
  /** What the device called itself when it paired, e.g. "Greg's iPhone". */
  name: string;
  /** SHA-256 of its token, hex. The token itself is never kept. */
  tokenHash: string;
  pairedAt: number;
  lastSeenAt: number | null;
}

/** One answer a paired device sent, kept so every press is attributed. */
export interface DeviceAnswerAuditEntry {
  at: number;
  deviceId: string;
  deviceName: string;
  runId: string;
  /** The connected host the run waits on, as named when answered; absent for this machine's own. */
  hostId?: string;
  hostName?: string;
  /** The option the device picked, by its label. */
  label: string;
  outcome: "answered" | "refused";
  /** Why nothing (or not everything) was pressed, when refused. */
  reason?: string;
}

export interface DeviceAnswerSettings {
  enabled: boolean;
  port: number;
  /** The tailnet name `tailscale serve` exposes this machine under, if any. */
  tailnetHost: string | null;
  devices: PairedDeviceRecord[];
  answers: DeviceAnswerAuditEntry[];
}

export type PairedDevice = Omit<PairedDeviceRecord, "tokenHash">;

export interface DeviceAnswerStatus {
  enabled: boolean;
  /** Whether the listener is up right now; false while off or after it failed to start. */
  listening: boolean;
  port: number;
  tailnetHost: string | null;
  /** Why the listener isn't up although it's on, in words Settings shows as is. */
  error: string | null;
  /** The open pairing code, formatted for reading, until it expires or is used. */
  pairing: { code: string; expiresAt: number } | null;
  devices: PairedDevice[];
  /** Newest first. */
  recentAnswers: DeviceAnswerAuditEntry[];
}

export interface SetDeviceAnswerPayload {
  enabled: boolean;
  port?: number;
  tailnetHost?: string | null;
}

export type DeviceAnswerEvent = { type: "status-changed"; status: DeviceAnswerStatus };
