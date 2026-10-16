/** A warning or error a view logged from a `plugin://` source. */
export interface PluginConsoleEntry {
  level: "warning" | "error";
  message: string;
  sourceId: string;
  lineNumber: number;
  /** Epoch ms when main received it. */
  timestamp: number;
}

/** A plugin panel's frame, in CSS pixels of the asking view's viewport. */
export interface PluginPanelCaptureRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PluginPanelCaptureResult {
  pngBase64: string;
  /** Every plugin-sourced entry the view has buffered; the renderer narrows it to one plugin. */
  consoleMessages: PluginConsoleEntry[];
}

/**
 * Largest PNG a capture hands back. Over it the capture is refused rather than
 * cut short: a truncated PNG does not decode.
 */
export const PLUGIN_PANEL_CAPTURE_MAX_PNG_BYTES = 4 * 1024 * 1024;
