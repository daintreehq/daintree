export { appendEmergencyLog, emergencyLogFatal, getEmergencyLogPath } from "./emergencyLog.js";
export { ResourceGovernor, type ResourceGovernorDeps } from "./ResourceGovernor.js";
export {
  BackpressureManager,
  type BackpressureDeps,
  type BackpressureStats,
  type PendingVisualSegment,
  MAX_PACKET_PAYLOAD,
  STREAM_STALL_SUSPEND_MS,
  MAX_PENDING_BYTES_PER_TERMINAL,
  MAX_TOTAL_PENDING_BYTES,
  BACKPRESSURE_RESUME_THRESHOLD,
  BACKPRESSURE_CHECK_INTERVAL_MS,
  BACKPRESSURE_MAX_PAUSE_MS,
} from "./backpressure.js";
export { IpcQueueManager, type IpcQueueDeps } from "./ipcQueue.js";
export { metricsEnabled } from "./metrics.js";
export { parseSpawnError } from "./spawnErrors.js";
export { toHostSnapshot, type SnapshotProvider } from "./snapshots.js";
