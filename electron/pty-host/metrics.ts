export function metricsEnabled(): boolean {
  return process.env.CANOPY_TERMINAL_METRICS === "1";
}
