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

export interface DemoSetZoomPayload {
  factor: number;
  durationMs?: number;
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
  maxFrames?: number;
  outputPath: string;
  preset: DemoEncodePreset;
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

export type DemoEncodePreset = "youtube-4k" | "youtube-1080p" | "web-webm";

export interface DemoEncodePayload {
  framesDir: string;
  outputPath: string;
  preset: DemoEncodePreset;
  fps?: number;
}

export interface DemoEncodeProgressEvent {
  frame: number;
  fps: number;
  percentComplete: number;
  etaSeconds: number;
}

export interface DemoEncodeResult {
  outputPath: string;
  durationMs: number;
}
