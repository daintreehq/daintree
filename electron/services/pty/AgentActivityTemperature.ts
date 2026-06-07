import {
  measureVisibleContentDelta,
  type VisibleContentSnapshot,
} from "./SustainedChangeTracker.js";

export const AGENT_OUTPUT_ACTIVITY_LINE_COUNT = 15;

const DEFAULT_HALF_LIFE_MS = 4500;
const DEFAULT_WORKING_THRESHOLD = 70;
const DEFAULT_WAITING_THRESHOLD = 40;
const DEFAULT_WORKING_DWELL_MS = 2000;
const DEFAULT_WORKING_MIN_CHANGED_SAMPLES = 4;
const DEFAULT_WORKING_MAX_CHANGE_GAP_MS = 900;
const DEFAULT_INDICATOR_MAX_CHANGE_GAP_MS = 2000;
const DEFAULT_WORKING_MIN_INDICATOR_SAMPLES = 2;
const DEFAULT_WAITING_DWELL_MS = 6000;
const DEFAULT_ACTIVE_GAP_RESET_MS = 3000;
const DEFAULT_RESIZE_QUIET_MS = 500;
const DEFAULT_MAX_TEMPERATURE = 100;
const DEFAULT_VISIBLE_BASE_IMPULSE = 22;
const DEFAULT_VISIBLE_LOG_SCALE = 8;
const DEFAULT_DECORATIVE_IMPULSE = 1;

export interface AgentActivityTemperatureOptions {
  halfLifeMs?: number;
  workingThreshold?: number;
  waitingThreshold?: number;
  workingDwellMs?: number;
  workingMinChangedSamples?: number;
  workingMaxChangeGapMs?: number;
  indicatorMaxChangeGapMs?: number;
  workingMinIndicatorSamples?: number;
  waitingDwellMs?: number;
  activeGapResetMs?: number;
  resizeQuietMs?: number;
  maxTemperature?: number;
  visibleBaseImpulse?: number;
  visibleLogScale?: number;
  decorativeImpulse?: number;
}

// "indicator" marks semantic status-line activity (spinner, retry countdown,
// elapsed-time counter) — strong liveness evidence that may tick as slowly as
// 1Hz, so it gets a looser change-gap and a lower sample minimum than generic
// "content" churn. "decorative" stays heat-capped noise.
export type AgentActivitySignalKind = "content" | "indicator" | "decorative";

export interface AgentActivityDeltaObservation {
  changedChars: number;
  decorative?: boolean;
  signalKind?: AgentActivitySignalKind;
}

export interface AgentActivityObservationResult {
  stateHint?: "busy" | "idle";
  changed: boolean;
  changedChars: number;
  heatAdded: number;
  temperature: number;
  suppressed: boolean;
  seeded: boolean;
}

export class AgentActivityTemperature {
  private readonly halfLifeMs: number;
  private readonly workingThreshold: number;
  private readonly waitingThreshold: number;
  private readonly workingDwellMs: number;
  private readonly workingMinChangedSamples: number;
  private readonly workingMaxChangeGapMs: number;
  private readonly indicatorMaxChangeGapMs: number;
  private readonly workingMinIndicatorSamples: number;
  private readonly waitingDwellMs: number;
  private readonly activeGapResetMs: number;
  private readonly resizeQuietMs: number;
  private readonly maxTemperature: number;
  private readonly visibleBaseImpulse: number;
  private readonly visibleLogScale: number;
  private readonly decorativeImpulse: number;

  private temperature = 0;
  private lastSampleAt = 0;
  private activeEvidenceStartedAt = 0;
  private lastChangedAt = 0;
  private quietStartedAt = 0;
  private resizeSuppressUntil = 0;
  private baselineInvalid = false;
  private lastSnapshot: VisibleContentSnapshot | undefined;
  private changedSampleCount = 0;
  private activeEvidenceKind: AgentActivitySignalKind = "content";

  constructor(options?: AgentActivityTemperatureOptions) {
    this.halfLifeMs = positive(options?.halfLifeMs, DEFAULT_HALF_LIFE_MS);
    this.workingThreshold = positive(options?.workingThreshold, DEFAULT_WORKING_THRESHOLD);
    this.waitingThreshold = positive(options?.waitingThreshold, DEFAULT_WAITING_THRESHOLD);
    this.workingDwellMs = nonNegative(options?.workingDwellMs, DEFAULT_WORKING_DWELL_MS);
    this.workingMinChangedSamples = positiveInteger(
      options?.workingMinChangedSamples,
      DEFAULT_WORKING_MIN_CHANGED_SAMPLES
    );
    this.workingMaxChangeGapMs = positive(
      options?.workingMaxChangeGapMs,
      DEFAULT_WORKING_MAX_CHANGE_GAP_MS
    );
    this.indicatorMaxChangeGapMs = positive(
      options?.indicatorMaxChangeGapMs,
      DEFAULT_INDICATOR_MAX_CHANGE_GAP_MS
    );
    this.workingMinIndicatorSamples = positiveInteger(
      options?.workingMinIndicatorSamples,
      DEFAULT_WORKING_MIN_INDICATOR_SAMPLES
    );
    this.waitingDwellMs = nonNegative(options?.waitingDwellMs, DEFAULT_WAITING_DWELL_MS);
    this.activeGapResetMs = positive(options?.activeGapResetMs, DEFAULT_ACTIVE_GAP_RESET_MS);
    this.resizeQuietMs = nonNegative(options?.resizeQuietMs, DEFAULT_RESIZE_QUIET_MS);
    this.maxTemperature = positive(options?.maxTemperature, DEFAULT_MAX_TEMPERATURE);
    this.visibleBaseImpulse = nonNegative(
      options?.visibleBaseImpulse,
      DEFAULT_VISIBLE_BASE_IMPULSE
    );
    this.visibleLogScale = nonNegative(options?.visibleLogScale, DEFAULT_VISIBLE_LOG_SCALE);
    this.decorativeImpulse = nonNegative(options?.decorativeImpulse, DEFAULT_DECORATIVE_IMPULSE);
  }

  getTemperature(now?: number): number {
    if (now !== undefined && !this.isResizeSuppressed(now)) {
      this.applyDecay(now);
    }
    return this.temperature;
  }

  reset(): void {
    this.temperature = 0;
    this.lastSampleAt = 0;
    this.activeEvidenceStartedAt = 0;
    this.lastChangedAt = 0;
    this.quietStartedAt = 0;
    this.resizeSuppressUntil = 0;
    this.baselineInvalid = false;
    this.lastSnapshot = undefined;
    this.changedSampleCount = 0;
    this.activeEvidenceKind = "content";
  }

  noteResize(now: number, quietMs = this.resizeQuietMs): void {
    this.resizeSuppressUntil = now + nonNegative(quietMs, this.resizeQuietMs);
    this.baselineInvalid = true;
    this.lastSnapshot = undefined;
    this.activeEvidenceStartedAt = 0;
    this.lastChangedAt = 0;
    this.quietStartedAt = 0;
    this.changedSampleCount = 0;
    this.activeEvidenceKind = "content";
  }

  seedSnapshot(snapshot: VisibleContentSnapshot, now: number): AgentActivityObservationResult {
    this.lastSnapshot = snapshot;
    this.lastSampleAt = now;
    this.quietStartedAt = now;
    this.clearResizeSuppression();
    return this.result(now, false, 0, 0, true, false);
  }

  observeSnapshot(
    now: number,
    snapshot: VisibleContentSnapshot,
    options?: { decorative?: boolean; signalKind?: AgentActivitySignalKind }
  ): AgentActivityObservationResult {
    const suppressed = this.consumeResizeSuppression(now);
    if (suppressed) {
      return this.result(now, false, 0, 0, false, true);
    }

    if (this.baselineInvalid || this.lastSnapshot === undefined) {
      return this.seedSnapshot(snapshot, now);
    }

    this.applyDecay(now);
    const delta = measureVisibleContentDelta(this.lastSnapshot, snapshot);
    this.lastSnapshot = snapshot;
    return this.observeDeltaAfterDecay(
      now,
      delta.changedChars,
      resolveSignalKind(options?.signalKind, options?.decorative)
    );
  }

  observeDelta(
    now: number,
    observation: AgentActivityDeltaObservation
  ): AgentActivityObservationResult {
    const suppressed = this.consumeResizeSuppression(now);
    if (suppressed) {
      return this.result(now, false, 0, 0, false, true);
    }

    if (this.baselineInvalid) {
      this.lastSampleAt = now;
      this.quietStartedAt = now;
      this.clearResizeSuppression();
      this.changedSampleCount = 0;
      return this.result(now, false, 0, 0, true, false);
    }

    this.applyDecay(now);
    return this.observeDeltaAfterDecay(
      now,
      observation.changedChars,
      resolveSignalKind(observation.signalKind, observation.decorative)
    );
  }

  private observeDeltaAfterDecay(
    now: number,
    rawChangedChars: number,
    signalKind: AgentActivitySignalKind
  ): AgentActivityObservationResult {
    const changedChars = Number.isFinite(rawChangedChars) ? Math.max(0, rawChangedChars) : 0;

    if (changedChars <= 0) {
      if (this.lastChangedAt > 0 && now - this.lastChangedAt > this.activeGapResetMs) {
        this.activeEvidenceStartedAt = 0;
        this.changedSampleCount = 0;
        this.activeEvidenceKind = "content";
      }
      if (this.quietStartedAt === 0) {
        this.quietStartedAt = now;
      }
      return this.result(now, false, 0, 0, false, false);
    }

    const heatAdded = this.heatForChange(changedChars, signalKind === "decorative");
    this.temperature = Math.min(this.maxTemperature, this.temperature + heatAdded);

    // Indicator-class changes (semantic status lines) may tick as slowly as
    // 1Hz, so they get a looser gap before the evidence window resets (#9874).
    // Generic content keeps the tight 900ms gate that guards against
    // scroll/resize repaint bursts (699d9a050).
    const maxChangeGapMs =
      signalKind === "indicator" ? this.indicatorMaxChangeGapMs : this.workingMaxChangeGapMs;
    if (
      this.activeEvidenceStartedAt === 0 ||
      (this.lastChangedAt > 0 && now - this.lastChangedAt > maxChangeGapMs)
    ) {
      this.activeEvidenceStartedAt = now;
      this.changedSampleCount = 0;
    }
    this.changedSampleCount += 1;
    this.activeEvidenceKind = signalKind;
    this.lastChangedAt = now;
    this.quietStartedAt = 0;

    return this.result(now, true, changedChars, heatAdded, false, false);
  }

  private result(
    now: number,
    changed: boolean,
    changedChars: number,
    heatAdded: number,
    seeded: boolean,
    suppressed: boolean
  ): AgentActivityObservationResult {
    return {
      stateHint: suppressed || seeded ? undefined : this.computeStateHint(now, changed),
      changed,
      changedChars,
      heatAdded,
      temperature: this.temperature,
      suppressed,
      seeded,
    };
  }

  private computeStateHint(now: number, changed: boolean): "busy" | "idle" | undefined {
    const minChangedSamples =
      this.activeEvidenceKind === "indicator"
        ? this.workingMinIndicatorSamples
        : this.workingMinChangedSamples;
    if (
      changed &&
      this.activeEvidenceKind !== "decorative" &&
      this.temperature >= this.workingThreshold &&
      this.activeEvidenceStartedAt > 0 &&
      this.changedSampleCount >= minChangedSamples &&
      now - this.activeEvidenceStartedAt >= this.workingDwellMs
    ) {
      return "busy";
    }

    if (
      this.temperature <= this.waitingThreshold &&
      this.quietStartedAt > 0 &&
      now - this.quietStartedAt >= this.waitingDwellMs
    ) {
      return "idle";
    }

    return undefined;
  }

  private heatForChange(changedChars: number, decorative: boolean): number {
    if (decorative) {
      return this.decorativeImpulse;
    }
    return Math.min(
      this.maxTemperature,
      this.visibleBaseImpulse + this.visibleLogScale * Math.log1p(changedChars)
    );
  }

  private applyDecay(now: number): void {
    if (this.lastSampleAt <= 0) {
      this.lastSampleAt = now;
      return;
    }

    const elapsed = Math.max(0, now - this.lastSampleAt);
    if (elapsed === 0) {
      return;
    }

    const decay = Math.pow(0.5, elapsed / this.halfLifeMs);
    this.temperature *= decay;
    if (this.temperature < 0.0001) {
      this.temperature = 0;
    }
    this.lastSampleAt = now;
  }

  private consumeResizeSuppression(now: number): boolean {
    if (!this.baselineInvalid) {
      return false;
    }

    if (this.isResizeSuppressed(now)) {
      this.lastSampleAt = now;
      return true;
    }

    return false;
  }

  private isResizeSuppressed(now: number): boolean {
    if (!this.baselineInvalid) {
      return false;
    }

    return now < this.resizeSuppressUntil;
  }

  private clearResizeSuppression(): void {
    this.resizeSuppressUntil = 0;
    this.baselineInvalid = false;
  }
}

function resolveSignalKind(
  signalKind: AgentActivitySignalKind | undefined,
  decorative: boolean | undefined
): AgentActivitySignalKind {
  return signalKind ?? (decorative === true ? "decorative" : "content");
}

function positive(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function nonNegative(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : fallback;
}
