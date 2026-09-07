/**
 * Device-emulation payloads for dev-preview webview guests.
 *
 * `DeviceEmulationParameters` mirrors `Electron.Parameters` field for field,
 * declared locally because `shared/` has no ambient Electron namespace and the
 * payload has to survive structured cloning across the IPC boundary. The main
 * process casts it back to `Electron.Parameters` at the `enableDeviceEmulation`
 * call site.
 */
export interface DeviceEmulationParameters {
  screenPosition: "desktop" | "mobile";
  screenSize: { width: number; height: number };
  viewPosition: { x: number; y: number };
  deviceScaleFactor: number;
  viewSize: { width: number; height: number };
  scale: number;
}

export interface DeviceEmulationSettings {
  params: DeviceEmulationParameters;
  /** Preset user agent to override the guest's own with. */
  userAgent: string;
  /**
   * Whether to emulate a touch screen. `enableDeviceEmulation` only drives
   * viewport/DSF/meta-viewport — pointer and hover media features and touch
   * dispatch need separate CDP `Emulation.*` commands.
   */
  touch: boolean;
}

/** `emulation: null` restores the guest to desktop (native metrics + its own UA). */
export interface DeviceEmulationRequest {
  webContentsId: number;
  panelId: string;
  emulation: DeviceEmulationSettings | null;
}
