/**
 * Periodic resource-status poll for worktrees that expose a status command
 * (cloud sandbox providers, remote compute, etc.). Runs independently from
 * the local-status poll because the underlying call is a remote round-trip,
 * not a git invocation. Cadence flips between active (focused) and background
 * tiers via the host interface.
 */

import { formatErrorMessage } from "../../shared/utils/errorMessage.js";

export interface ResourcePollTimerHost {
  readonly isRunning: boolean;
  /** False while the project is backgrounded; nothing may arm or re-arm. */
  readonly pollingEnabled: boolean;
  readonly hasResourceConfig: boolean;
  readonly hasStatusCommand: boolean;
  /** Interval in milliseconds. 0 disables auto-polling. */
  readonly resourcePollIntervalMs: number;
  readonly worktreeId: string;
  /**
   * Execute the resource status poll. Errors are swallowed by the timer
   * — provider-specific failure recovery is the callback's responsibility.
   */
  onResourceStatusPoll(worktreeId: string): Promise<unknown> | void;
}

const RESOURCE_POLL_JITTER_FACTOR = 0.1;

function randomBetween(minMs: number, maxMs: number): number {
  if (maxMs <= minMs) return minMs;
  return minMs + Math.floor(Math.random() * (maxMs - minMs));
}

export class ResourcePollTimer {
  private timer: NodeJS.Timeout | null = null;
  private disposed = false;

  constructor(private readonly host: ResourcePollTimerHost) {}

  /**
   * Schedule the next poll. Idempotent — no-op if a timer is already armed,
   * if disposed, or if the interval/feature gates are not satisfied.
   */
  schedule(): void {
    if (this.disposed) return;
    if (this.timer) return;
    if (!this.host.pollingEnabled) return;
    if (this.host.resourcePollIntervalMs <= 0) return;
    if (!this.host.hasResourceConfig || !this.host.hasStatusCommand) return;

    const baseInterval = this.host.resourcePollIntervalMs;
    const delay =
      baseInterval + randomBetween(0, Math.floor(baseInterval * RESOURCE_POLL_JITTER_FACTOR));
    this.timer = setTimeout(async () => {
      this.timer = null;
      if (this.disposed) return;
      // Re-check at fire time — feature flags or running state may have
      // flipped between schedule and fire.
      if (
        !this.host.isRunning ||
        !this.host.pollingEnabled ||
        !this.host.hasResourceConfig ||
        !this.host.hasStatusCommand ||
        this.host.resourcePollIntervalMs <= 0
      ) {
        return;
      }
      try {
        await this.host.onResourceStatusPoll(this.host.worktreeId);
      } catch (err) {
        console.warn(
          `[ResourcePollTimer] Poll callback failed for ${this.host.worktreeId}:`,
          formatErrorMessage(err, "Resource status poll failed")
        );
      }
      // schedule() also declines on a paused host, so a poll that was in
      // flight when the project was backgrounded can't restart the cadence.
      if (this.disposed || !this.host.isRunning) return;
      this.schedule();
    }, delay);
    this.timer.unref();
  }

  /** Cancel any armed timer without disposing — used by focus flips and pause. */
  clear(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
