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
}
