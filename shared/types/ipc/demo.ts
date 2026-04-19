export interface DemoMoveToPayload {
  x: number;
  y: number;
  durationMs?: number;
}

export interface DemoTypePayload {
  selector: string;
  text: string;
  cps?: number;
}

export interface DemoWaitForSelectorPayload {
  selector: string;
  timeoutMs?: number;
}

export interface DemoSleepPayload {
  durationMs: number;
}

export interface DemoMoveToSelectorPayload {
  selector: string;
  durationMs?: number;
  offsetX?: number;
  offsetY?: number;
}

export interface DemoScreenshotResult {
  data: Uint8Array;
  width: number;
  height: number;
}

export interface DemoStartCapturePayload {
  fps?: number;
  outputPath: string;
}

export interface DemoCaptureChunkPayload {
  captureId: string;
  data: Uint8Array;
}

export interface DemoCaptureStopPayload {
  captureId: string;
  frameCount: number;
  error?: string;
}

export interface DemoExecStartCapturePayload {
  captureId: string;
  requestId: string;
  fps: number;
  mimeType: string;
}

export interface DemoExecStopCapturePayload {
  captureId: string;
  requestId: string;
}

export interface DemoStartCaptureResult {
  outputPath: string;
}

export interface DemoStopCaptureResult {
  outputPath: string;
  frameCount: number;
}

export interface DemoCaptureStatus {
  active: boolean;
  frameCount: number;
  outputPath: string | null;
}

export interface DemoScrollPayload {
  selector: string;
}

export interface DemoDragPayload {
  fromSelector: string;
  toSelector: string;
  durationMs?: number;
}

export interface DemoPressKeyPayload {
  key: string;
  code?: string;
  modifiers?: Array<"mod" | "ctrl" | "shift" | "alt" | "meta">;
  selector?: string;
}

export interface DemoSpotlightPayload {
  selector: string;
  padding?: number;
}

export interface DemoAnnotatePayload {
  selector: string;
  text: string;
  position?: "top" | "bottom" | "left" | "right";
  id?: string;
}

export interface DemoAnnotateResult {
  id: string;
}

export interface DemoDismissAnnotationPayload {
  id?: string;
}

export interface DemoWaitForIdlePayload {
  settleMs?: number;
  timeoutMs?: number;
}
