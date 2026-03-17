export interface DemoMoveToPayload {
  x: number;
  y: number;
  durationMs: number;
}

export interface DemoTypePayload {
  selector: string;
  text: string;
  cps?: number;
}

export interface DemoSetZoomPayload {
  factor: number;
  durationMs?: number;
}

export interface DemoWaitForSelectorPayload {
  selector: string;
  timeoutMs?: number;
}

export interface DemoScreenshotResult {
  data: Uint8Array;
  width: number;
  height: number;
}
