/**
 * What the worker and the views agree on. Imported by both sides and inlined
 * into each bundle, so nothing here may touch the host or the DOM.
 */

export const REQUEST_STATUSES = ["open", "in_progress", "done"] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export interface RequestRecord {
  id: string;
  title: string;
  status: RequestStatus;
  notes: string;
  /** Raised by every write; an update naming an older revision is refused. */
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export type ReportState =
  | "pending"
  | "submitting"
  | "uncertain"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "abandoned";

export interface ReportSummary {
  operationId: string;
  state: ReportState;
  /** Set once the provider finished and the report file exists. */
  reportId: string | null;
  requestCount: number | null;
  fraction: number | null;
  error: string | null;
  createdAt: number;
}

export interface ConnectionStatus {
  connected: boolean;
  workspace: string | null;
}

/** The channels the views call with `invoke`. */
export const CHANNELS = {
  list: "requests.list",
  get: "requests.get",
  add: "requests.add",
  update: "requests.update",
  reports: "reports.list",
  startReport: "reports.start",
  retryReport: "reports.retry",
  reportArtifact: "reports.artifact",
  connection: "connection.get",
  connect: "connection.connect",
  testConnection: "connection.test",
  disconnect: "connection.disconnect",
} as const;

/** Pushes from the worker, used only to invalidate what a view shows. */
export const EVENTS = {
  requestsChanged: "requests-changed",
  reportsChanged: "reports-changed",
  connectionChanged: "connection-changed",
} as const;

export interface UpdateRequestArgs {
  id: string;
  revision: number;
  title?: string;
  status?: RequestStatus;
  notes?: string;
}

export type UpdateRequestResult =
  | { ok: true; request: RequestRecord }
  | { ok: false; reason: "not-found" }
  | { ok: false; reason: "conflict"; current: RequestRecord };

export const MAX_TITLE_CHARS = 120;
export const MAX_NOTES_CHARS = 2000;
