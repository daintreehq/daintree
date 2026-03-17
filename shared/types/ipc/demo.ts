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

export interface DemoSleepPayload {
  durationMs: number;
}

export interface DemoScreenshotResult {
  data: Uint8Array;
  width: number;
  height: number;
}

export interface DemoStartCapturePayload {
  fps?: number;
  maxFrames?: number;
  outputDir?: string;
}

export interface DemoStartCaptureResult {
  outputDir: string;
}

export interface DemoStopCaptureResult {
  outputDir: string;
  frameCount: number;
}

export interface DemoCaptureStatus {
  active: boolean;
  frameCount: number;
  outputDir: string | null;
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
