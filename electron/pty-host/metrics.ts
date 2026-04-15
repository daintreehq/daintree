export function metricsEnabled(): boolean {
  return process.env.DAINTREE_TERMINAL_METRICS === "1";
}
