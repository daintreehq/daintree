/** Adaptive backoff metrics */
export interface AdaptiveBackoffMetrics {
  lastOperationDuration: number;
  consecutiveFailures: number;
  circuitBreakerTripped: boolean;
  currentInterval: number;
}

/** Terminal configuration for scrollback, etc. */
export interface TerminalConfig {
  scrollbackLines: number; // 100-10000 (user-configurable)
  performanceMode: boolean;
  fontSize?: number;
  fontFamily?: string;
  /** Master toggle for the hybrid input bar shown on agent terminals (default: true) */
  hybridInputEnabled?: boolean;
  /** When selecting a terminal pane, focus the hybrid input bar instead of xterm (default: true) */
  hybridInputAutoFocus?: boolean;
  /** Selected terminal color scheme ID */
  colorSchemeId?: string;
  /** Custom imported color schemes (serialized) */
  customSchemes?: string;
  /** Screen reader mode: 'auto' (follow OS), 'on', or 'off' (default: 'auto') */
  screenReaderMode?: "auto" | "on" | "off";
  /** Show per-terminal CPU and memory usage in panel headers (default: false) */
  resourceMonitoringEnabled?: boolean;
}
