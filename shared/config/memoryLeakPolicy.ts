/** Auto-restart threshold when the host's settings name none, in MB. */
export const DEFAULT_AUTO_RESTART_THRESHOLD_MB = 8192;

/** Resource samples a terminal is given after it starts before the threshold applies. */
export const AUTO_RESTART_STARTUP_SAMPLES = 30;

/**
 * The host's memory-leak policy as its terminal settings define it: detection
 * follows resource monitoring unless set on its own, and nothing is measured
 * while monitoring is off.
 */
export function resolveMemoryLeakPolicy(config: {
  resourceMonitoringEnabled?: boolean;
  memoryLeakDetectionEnabled?: boolean;
  memoryLeakAutoRestartThresholdMb?: number;
}): { enabled: boolean; thresholdMb: number } {
  const monitoring = config.resourceMonitoringEnabled === true;
  return {
    enabled: monitoring && (config.memoryLeakDetectionEnabled ?? monitoring),
    thresholdMb: config.memoryLeakAutoRestartThresholdMb ?? DEFAULT_AUTO_RESTART_THRESHOLD_MB,
  };
}
