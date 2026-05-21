export type CdpRemoteArgPrimitive = {
  type: "primitive";
  kind: "string" | "number" | "boolean" | "null" | "undefined" | "symbol" | "bigint";
  value: string | number | boolean | null;
};

export type CdpRemoteArgObject = {
  type: "object";
  objectId: string;
  className?: string;
  subtype?: string;
  description?: string;
  preview?: string;
};

export type CdpRemoteArgFunction = {
  type: "function";
  objectId: string;
  description: string;
};

export type CdpRemoteArg = CdpRemoteArgPrimitive | CdpRemoteArgObject | CdpRemoteArgFunction;

export interface CdpStackFrame {
  functionName: string;
  url: string;
  lineNumber: number;
  columnNumber: number;
}

export interface CdpStackTrace {
  callFrames: CdpStackFrame[];
}

export type CdpConsoleType =
  | "log"
  | "info"
  | "warning"
  | "error"
  | "debug"
  | "dir"
  | "trace"
  | "startGroup"
  | "startGroupCollapsed"
  | "endGroup"
  | "table"
  | "count"
  | "timeEnd"
  | "assert"
  // Rows sourced from CDP `Log.entryAdded` (browser-emitted: CSP violations,
  // network failures, deprecations) rather than `Runtime.consoleAPICalled`.
  | "log-entry";

// Source classification for `Log.entryAdded` rows. Mirrors the Chromium
// `LogEntry.source` enum (subset we surface); unknown sources fall back to "other".
export type CdpLogEntrySource =
  | "javascript"
  | "network"
  | "deprecation"
  | "security"
  | "violation"
  | "intervention"
  | "recommendation"
  | "worker"
  | "other";

export interface SerializedConsoleRow {
  id: number;
  paneId: string;
  level: "log" | "info" | "warning" | "error";
  cdpType: CdpConsoleType;
  args: CdpRemoteArg[];
  summaryText: string;
  stackTrace?: CdpStackTrace;
  groupDepth: number;
  timestamp: number;
  navigationGeneration: number;
  // Present only on `cdpType: "log-entry"` rows — classifies the browser
  // subsystem that emitted the entry (CSP/security, network, deprecation, …).
  category?: CdpLogEntrySource;
}

export interface CdpPropertyDescriptor {
  name: string;
  value?: CdpRemoteArg;
  configurable: boolean;
  enumerable: boolean;
  writable?: boolean;
  isOwn?: boolean;
}

export interface CdpGetPropertiesResult {
  properties: CdpPropertyDescriptor[];
}
