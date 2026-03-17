export interface DetectedDevServer {
  url: string;
  port: number;
  terminalId: string;
  worktreeId?: string;
  terminalTitle?: string;
  detectedAt: number;
}

export interface GlobalDevServersGetResult {
  servers: DetectedDevServer[];
}

export interface GlobalDevServersChangedPayload {
  servers: DetectedDevServer[];
}
