export function readPhysFootprints(pids: number[]): Array<number | null> | null;
export interface ThreadPoolPolicyResult {
  requested: number;
  applied: number;
  errors: number[];
}
export function disableThreadPoolDatalessMaterialization(
  threads: number,
  timeoutMs: number
): Promise<ThreadPoolPolicyResult> | null;
export function isAvailable(): boolean;
export function getLoadError(): unknown;
