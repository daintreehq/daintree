// Cached at module load: the utility-process env is fixed at fork, and this
// is called once per PTY data chunk — process.env reads hit a C++ interceptor.
const enabled = process.env.DAINTREE_TERMINAL_METRICS === "1";

export function metricsEnabled(): boolean {
  return enabled;
}
