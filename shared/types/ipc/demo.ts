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
  /**
   * Target encode bitrate in bits/sec for the MediaRecorder. Higher = sharper,
   * larger files. Defaults to a very-high-quality value chosen by the main
   * handler when omitted. Set explicitly for embeddable/master-quality output.
   */
  videoBitsPerSecond?: number;
  /** Force the captured frame width in device pixels (getDisplayMedia ideal). */
  width?: number;
  /** Force the captured frame height in device pixels (getDisplayMedia ideal). */
  height?: number;
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
  videoBitsPerSecond?: number;
  width?: number;
  height?: number;
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

export type DemoAnnotationPlacement =
  // Anchored to a target element (requires `selector`).
  | "top"
  | "bottom"
  | "left"
  | "right"
  // Anchored to the viewport (selector ignored). screen-bottom is subtitle style.
  | "screen-top"
  | "screen-bottom"
  | "screen-center"
  | "lower-third-left"
  | "lower-third-right"
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right"
  // Anchored to the demo cursor's position at annotate time.
  | "above-cursor"
  | "below-cursor";

/** Caption size tier — resolved to a fraction of frame height so it scales across 1080p/4K. */
export type DemoAnnotationSize = "sm" | "md" | "lg" | "xl";

export interface DemoAnnotatePayload {
  /**
   * Target element. Required for element-anchored placements (top/bottom/left/
   * right); ignored for screen-* and cursor placements.
   */
  selector?: string;
  text: string;
  position?: DemoAnnotationPlacement;
  /** Size tier; defaults to "md". */
  size?: DemoAnnotationSize;
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
