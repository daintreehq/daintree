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
  | "assert";

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
