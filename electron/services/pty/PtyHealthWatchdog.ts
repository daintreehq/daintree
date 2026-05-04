/**
 * PtyHealthWatchdog - Heartbeat watchdog and RTT observability for the PTY host.
 *
 * Owns the missed-heartbeat counter, the heartbeat interval timer, the
 * sleep/wake handshake state, and the rolling RTT sample buffer. PtyClient
 * delegates all of this here so the lifecycle of a single host run can be
 * tested without spinning up a UtilityProcess.
 *
 * Behavior is preserved from the original inline implementation in PtyClient:
 *   - On every interval tick, increment `missedHeartbeats` then send `health-check`.
 *     The next `pong` resets the counter via {@link recordPong}.
 *   - When `missedHeartbeats >= maxMissedHeartbeats`, force-kill the host via
 *     `process.kill(child.pid, "SIGKILL")` and emit `host-crash-details`. The
 *     UtilityProcess `kill()` method only sends SIGTERM, so SIGKILL must come
 *     from the OS.
 *   - The handshake state (`isWaitingForHandshake`, `handshakeTimeout`) gates
 *     the resume-after-sleep dance: send one ping, wait up to 5s for the pong,
 *     then start the normal interval (whether or not the pong arrived).
 *
 * Public state fields are exposed for backward-compatible test access; the
 * existing PtyClient tests pre-extract reach into `priv.missedHeartbeats`
 * etc., and continue to work via the proxy properties on PtyClient.
 */

import { performance } from "node:perf_hooks";
import type { UtilityProcess } from "electron";
import type { HostCrashPayload, PtyHostRequest } from "../../../shared/types/pty-host.js";

const HANDSHAKE_TIMEOUT_MS = 5_000;
const RTT_BUFFER_SIZE = 20;
const RTT_LOG_EVERY_N_SAMPLES = 10;
const RTT_LOG_INTERVAL_MS = 5 * 60 * 1000;
const RTT_WARN_THRESHOLD_MS = 5_000;

function rttPercentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (p <= 0) return sorted[0];
  if (p >= 1) return sorted[sorted.length - 1];
  const idx = p * (sorted.length - 1);
  const low = Math.floor(idx);
  const high = Math.ceil(idx);
  if (low === high) return sorted[low];
  const frac = idx - low;
  return sorted[low] * (1 - frac) + sorted[high] * frac;
}

export interface PtyHealthWatchdogDeps {
  intervalMs: number;
  maxMissedHeartbeats: number;
  /** Returns the current child reference; null when the host is dead. */
  getChild: () => UtilityProcess | null;
  /** Returns whether the host has emitted `ready`. The interval no-ops until then. */
  isHostInitialized: () => boolean;
  /** Send a `health-check` request to the host. */
  send: (request: PtyHostRequest) => void;
  /** Emit a host-crash-details event when the watchdog force-kills the host. */
  emitCrashDetails: (payload: HostCrashPayload) => void;
}

export class PtyHealthWatchdog {
  /** Number of consecutive ticks since the last `pong`. Public for test access. */
  missedHeartbeats = 0;
  /** Active interval timer, or null when paused / not started. */
  healthCheckInterval: NodeJS.Timeout | null = null;
  /** True between pauseHealthCheck() and resumeHealthCheck(). */
  isHealthCheckPaused = false;
  /** True between sending the wake handshake ping and the matching pong / fallback. */
  isWaitingForHandshake = false;
  /** Fallback timer for the wake handshake; cleared on pong or pause. */
  handshakeTimeout: NodeJS.Timeout | null = null;
  /** Timestamp of the in-flight ping, or null if none. */
  lastPingTime: number | null = null;
  /** Rolling buffer of recent RTT samples (capped at RTT_BUFFER_SIZE). */
  rttSamples: number[] = [];
  /** Counter for the periodic summary log; resets on each emit. */
  rttSamplesSinceLastLog = 0;
  /** Timestamp of the last summary emit. */
  lastRttLogTime = 0;

  constructor(private readonly deps: PtyHealthWatchdogDeps) {}

  /**
   * Start the heartbeat interval. Resets `missedHeartbeats` and clears any
   * existing interval first so this is safe to call multiple times.
   */
  start(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }

    this.missedHeartbeats = 0;
    this.lastRttLogTime = performance.now();

    this.healthCheckInterval = setInterval(() => {
      const child = this.deps.getChild();
      if (!this.deps.isHostInitialized() || !child || this.isHealthCheckPaused) return;

      // WATCHDOG CHECK: Force-kill if host is unresponsive
      if (this.missedHeartbeats >= this.deps.maxMissedHeartbeats) {
        const missedMs = this.missedHeartbeats * this.deps.intervalMs;
        console.error(
          `[PtyClient] Watchdog: Host unresponsive for ${this.missedHeartbeats} checks (${missedMs}ms). Force killing.`
        );

        const crashPayload: HostCrashPayload = {
          code: null,
          signal: "SIGKILL",
          crashType: "SIGNAL_TERMINATED",
          timestamp: Date.now(),
        };
        this.deps.emitCrashDetails(crashPayload);

        // Force kill with SIGKILL (UtilityProcess.kill() only sends SIGTERM)
        if (child.pid) {
          process.kill(child.pid, "SIGKILL");
        }
        this.missedHeartbeats = 0;
        this.lastPingTime = null;
        return;
      }

      this.missedHeartbeats++;
      this.lastPingTime = performance.now();
      this.deps.send({ type: "health-check" });
    }, this.deps.intervalMs);

    console.log("[PtyClient] Health check interval started (watchdog enabled)");
  }

  /**
   * Stop the heartbeat interval and clear all RTT/ping state. Called from the
   * exit handler so a fresh host run starts with empty buffers.
   */
  stop(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
    this.lastPingTime = null;
    this.rttSamples = [];
    this.rttSamplesSinceLastLog = 0;
    this.lastRttLogTime = 0;
  }

  /**
   * Pause the heartbeat for system sleep. Tears down both the interval and any
   * in-flight handshake fallback so a rapid suspend/resume can't strand state.
   */
  pause(): void {
    if (this.isHealthCheckPaused) return;
    this.isHealthCheckPaused = true;
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
    if (this.handshakeTimeout) {
      clearTimeout(this.handshakeTimeout);
      this.handshakeTimeout = null;
    }
    this.isWaitingForHandshake = false;
    this.lastPingTime = null;
    console.log("[PtyClient] Health check paused");
  }

  /**
   * Resume after system wake. Returns true if a handshake was initiated; false
   * if it was rejected (already running, or host not ready). When false, the
   * caller should not expect any subsequent state changes from the watchdog.
   */
  resume(): boolean {
    if (!this.isHealthCheckPaused) return false;
    if (!this.deps.isHostInitialized() || !this.deps.getChild()) {
      console.warn("[PtyClient] Cannot resume health check - host not ready");
      this.isHealthCheckPaused = false;
      return false;
    }

    this.isHealthCheckPaused = false;

    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
    if (this.handshakeTimeout) {
      clearTimeout(this.handshakeTimeout);
      this.handshakeTimeout = null;
    }

    console.log("[PtyClient] System resumed. Initiating handshake...");
    this.isWaitingForHandshake = true;
    this.lastPingTime = performance.now();
    this.deps.send({ type: "health-check" });

    this.handshakeTimeout = setTimeout(() => {
      if (this.isWaitingForHandshake) {
        console.warn("[PtyClient] Handshake timeout - forcing health check resume");
        this.isWaitingForHandshake = false;
        this.handshakeTimeout = null;
        this.lastPingTime = null;
        this.start();
      }
    }, HANDSHAKE_TIMEOUT_MS);
    return true;
  }

  /**
   * Process an incoming `pong`. Resets the missed-heartbeat counter, records
   * the RTT sample, and — if a handshake was outstanding — clears it and
   * starts the normal interval.
   */
  recordPong(): void {
    this.missedHeartbeats = 0;
    if (this.lastPingTime !== null) {
      const now = performance.now();
      const rtt = now - this.lastPingTime;
      this.lastPingTime = null;
      this.recordRtt(rtt, now);
    }
    if (this.isWaitingForHandshake) {
      this.isWaitingForHandshake = false;
      if (this.handshakeTimeout) {
        clearTimeout(this.handshakeTimeout);
        this.handshakeTimeout = null;
      }
      console.log("[PtyClient] Handshake successful - resuming health checks");
      this.start();
    }
  }

  /** Whether the watchdog is currently armed (interval running). */
  isRunning(): boolean {
    return this.healthCheckInterval !== null;
  }

  /** Stop everything; called from PtyClient.dispose(). */
  dispose(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
    if (this.handshakeTimeout) {
      clearTimeout(this.handshakeTimeout);
      this.handshakeTimeout = null;
    }
    this.isWaitingForHandshake = false;
    this.lastPingTime = null;
  }

  private recordRtt(rtt: number, now: number): void {
    this.rttSamples.push(rtt);
    if (this.rttSamples.length > RTT_BUFFER_SIZE) {
      this.rttSamples.shift();
    }
    this.rttSamplesSinceLastLog++;

    if (rtt > RTT_WARN_THRESHOLD_MS) {
      console.warn(
        `[PtyClient] Heartbeat RTT spike: ${rtt.toFixed(1)}ms (> ${RTT_WARN_THRESHOLD_MS}ms)`
      );
    }

    const countTrigger = this.rttSamplesSinceLastLog >= RTT_LOG_EVERY_N_SAMPLES;
    const timeTrigger = now - this.lastRttLogTime >= RTT_LOG_INTERVAL_MS;
    if (!countTrigger && !timeTrigger) return;

    const sorted = [...this.rttSamples].sort((a, b) => a - b);
    const p50 = rttPercentile(sorted, 0.5);
    const p95 = rttPercentile(sorted, 0.95);
    const p99 = rttPercentile(sorted, 0.99);
    const max = sorted[sorted.length - 1] ?? 0;
    console.log(
      `[PtyClient] Heartbeat RTT (last ${sorted.length}): p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms p99=${p99.toFixed(1)}ms max=${max.toFixed(1)}ms samples=${this.rttSamplesSinceLastLog}`
    );
    this.rttSamplesSinceLastLog = 0;
    this.lastRttLogTime = now;
  }
}
