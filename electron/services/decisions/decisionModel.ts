import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  DecisionLearner,
  LearnedDecision,
  ProxyEngine,
  ProxyOutcome,
  ProxyQuestionInput,
} from "@daintreehq/decisions-client";
import {
  DEFAULT_BLOCKED_GATES,
  MemoryHistoryStore,
  asBridgeEngine,
  asBridgeLearner,
  commandPresets,
  createDecisionModel,
  matchesGate,
  type CalibrationData,
  type DecisionModel,
  type DecisionModelAdapter,
  type EvaluationReport,
  type HistoryStore,
} from "@daintreehq/decisions-model";
import { SqliteHistoryStore } from "@daintreehq/decisions-model/sqlite";
import {
  DECISIONS_MODEL_ADAPTERS,
  type DecisionsModelAdapter,
  type DecisionsSettings,
} from "../../../shared/types/decisions.js";
import type {
  DecisionsModelEvaluation,
  DecisionsModelReport,
  DecisionsModelRun,
  DecisionsModelRunEnd,
  DecisionsModelThreshold,
} from "../../../shared/types/decisionsModel.js";
import {
  OWNER_RW_FILE_MODE,
  ensureOwnerOnlyDir,
  resilientAtomicWriteFile,
  resilientUnlink,
  syncParentDirectory,
  tightenFilePermissionsSync,
} from "../../utils/fs.js";
import { SETUP_DIAGNOSTIC_PROJECT_ID } from "./setupDiagnostic.js";
import { DESIGN_REVIEW_FINAL_GATE_ID } from "./workflowGates.js";

/**
 * Where the decision model keeps what it learned, beside the Decisions keys
 * and never in the app database, whose rows hold no question or answer text.
 */
export interface DecisionModelFiles {
  /** The person's answers, secrets filtered, in clear: the model's history. */
  history: string;
  /** The latest evaluation of that history, and the threshold chosen after reading it. */
  evaluation: string;
  /** Everything deleting the model's data removes: the history with SQLite's companions, and the evaluation. */
  all: readonly string[];
}

export function decisionModelFiles(keyFilePath: string): DecisionModelFiles {
  const dir = dirname(keyFilePath);
  const history = join(dir, "model-history.sqlite");
  const evaluation = join(dir, "model-evaluation.json");
  return {
    history,
    evaluation,
    all: [history, `${history}-journal`, `${history}-wal`, `${history}-shm`, evaluation],
  };
}

/**
 * What the person read before letting the model answer: the library's
 * replay of their own history through one CLI (#16027 shows it), and the
 * confidence they then chose to allow automatic answers from.
 */
export interface DecisionModelEvaluation {
  /** The CLI the replay ran. It says nothing of another, so choosing another disarms the proxy. */
  adapter: DecisionsModelAdapter;
  /** Epoch ms. */
  evaluatedAt: number;
  /** The library's report without its per-question items, which name each question. */
  report: Omit<EvaluationReport, "items">;
  /**
   * The confidence automatic answers need, chosen after this report; null
   * until one is. A new evaluation starts at null, so nothing answers on
   * evidence the person hasn't seen. The library honours it only while the
   * report's calibration supports exactly it.
   */
  autoAnswerThreshold: number | null;
}

/** The model's preferences as the setting holds them. */
export type DecisionModelPreferences = Pick<DecisionsSettings, "modelLearning" | "modelAdapter">;

export interface DecisionModelRuntimeOptions {
  files: DecisionModelFiles;
  /**
   * The armed proxy changed: armed, disarmed, or another model. A relay
   * attempt asks the proxy it started with, so the connection replaces it.
   */
  onProxyChanged(): void;
  /**
   * Something a snapshot shows changed: the history opened, closed, grew or
   * was cleared, an evaluation started, ended or was stored, or a threshold
   * was chosen. Settings reads the model again on it.
   */
  onChanged?(): void;
  /** Opens the history; the library's SQLite store unless a test says otherwise. */
  openHistory?: (path: string) => HistoryStore;
  /** The chosen CLI's adapter, which runs nothing until it is asked something. */
  createAdapter?: (adapter: DecisionsModelAdapter) => DecisionModelAdapter;
  now?: () => number;
}

function abstain(reason: string): ProxyOutcome {
  return { action: "abstain", reason };
}

function isThreshold(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

/** What a cancelled evaluation rejects with, so its end reads as cancelled rather than failed. */
function evaluationCancelled(): Error {
  const error = new Error("The decision model's evaluation was cancelled");
  error.name = "AbortError";
  return error;
}

/** What a threshold chosen from an older report rejects with, so it reads as stale rather than failed. */
export function staleEvaluation(): Error {
  const error = new Error("The decision model was evaluated again since that report was read");
  error.name = "StaleEvaluationError";
  return error;
}

/** Answers nothing: the verifier below never asks it anything. */
const UNASKED_ADAPTER: DecisionModelAdapter = {
  id: "daintree-threshold-check",
  suggest: () => Promise.reject(new Error("Nothing asks this adapter")),
};

/**
 * Whether the library would answer automatically from `threshold` against
 * `calibration`, by its own rule for exactly that threshold, asked of a model
 * of its own so the one that answers is never touched and no rule is copied.
 */
export function thresholdSupported(calibration: CalibrationData, threshold: number): boolean {
  const verifier = createDecisionModel({
    history: new MemoryHistoryStore(),
    adapter: UNASKED_ADAPTER,
  });
  verifier.setCalibration(calibration);
  verifier.setAutoAnswerThreshold(threshold);
  return verifier.effectiveThreshold() === threshold;
}

/**
 * The thresholds to offer after an evaluation: each confidence band's floor
 * and the library's recommendation, kept only where the library honours them
 * (which needn't hold for every higher one), with the replay's evidence.
 */
export function supportedThresholds(
  report: DecisionModelEvaluation["report"],
  /** The threshold already chosen, offered too so the choice in force is always listed. */
  chosen: number | null = null
): DecisionsModelThreshold[] {
  const calibration = report.calibration;
  const candidates = new Set<number>();
  if (isThreshold(chosen)) candidates.add(chosen);
  for (const bucket of Array.isArray(report.buckets) ? report.buckets : []) {
    if (isThreshold(bucket?.lo)) candidates.add(bucket.lo);
  }
  if (isThreshold(report.recommended_threshold)) candidates.add(report.recommended_threshold);
  const points = calibration.points.filter(
    (point) => typeof point?.confidence === "number" && typeof point.correct === "boolean"
  );
  return [...candidates]
    .sort((a, b) => a - b)
    .filter((threshold) => thresholdSupported(calibration, threshold))
    .map((threshold) => {
      const band = points.filter((point) => point.confidence >= threshold);
      return {
        threshold,
        answered: band.length,
        matched: band.filter((point) => point.correct).length,
      };
    });
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** The report as counts for Settings, read defensively: the file it came from is the person's to damage. */
export function describeReport(report: DecisionModelEvaluation["report"]): DecisionsModelReport {
  const byKind: DecisionsModelReport["byKind"] = {};
  for (const [kind, value] of Object.entries(report.by_kind ?? {})) {
    byKind[kind] = { answered: count(value?.answered), matched: count(value?.correct) };
  }
  const abstainReasons: Record<string, number> = {};
  for (const [reason, value] of Object.entries(report.abstain_reasons ?? {})) {
    abstainReasons[reason] = count(value);
  }
  return {
    total: count(report.total),
    scored: count(report.scored),
    answered: count(report.answered),
    matched: count(report.correct),
    abstained: count(report.abstained),
    buckets: (Array.isArray(report.buckets) ? report.buckets : []).map((bucket) => ({
      lo: count(bucket?.lo),
      hi: count(bucket?.hi),
      answered: count(bucket?.n),
      matched: count(bucket?.correct),
    })),
    abstainReasons,
    byKind,
    targetAccuracy: count(report.target_accuracy),
    minSamples: count(report.min_samples),
    recommendedThreshold: isThreshold(report.recommended_threshold)
      ? report.recommended_threshold
      : null,
  };
}

/** A stored evaluation as Settings shows it. */
export function describeEvaluation(evaluation: DecisionModelEvaluation): DecisionsModelEvaluation {
  return {
    adapter: evaluation.adapter,
    evaluatedAt: evaluation.evaluatedAt,
    report: describeReport(evaluation.report),
    autoAnswerThreshold: evaluation.autoAnswerThreshold,
    thresholds: supportedThresholds(evaluation.report, evaluation.autoAnswerThreshold),
  };
}

/**
 * Deletes the model's history, its SQLite companions and its evaluation,
 * with nothing holding them open. The evaluation goes first, since it is what
 * arms the proxy, and the database last, after the journal and WAL that could
 * otherwise be replayed into a new one: a deletion a crash cut short leaves at
 * worst history still listed as stored, never an armed proxy over an emptied
 * history. Each removal is made durable before the next.
 */
export async function deleteDecisionModelFiles(files: DecisionModelFiles): Promise<void> {
  const history = files.history;
  for (const path of [
    files.evaluation,
    `${history}-wal`,
    `${history}-shm`,
    `${history}-journal`,
    history,
  ]) {
    try {
      await resilientUnlink(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") continue;
      throw error;
    }
    await syncParentDirectory(path);
  }
}

/**
 * Why a question is never put to the model, whatever it would say. The
 * bridge asks about no `human-required` question and the model blocks its own
 * list, so this is the same rule kept here too: no caller and no model
 * release can answer a design review or a question only the person may.
 */
export function proxyRefusal(input: ProxyQuestionInput): string | null {
  const requirement: string = input.requirement;
  if (requirement !== "proxy-ok" && requirement !== "proxy-first") return "human-required";
  const gate = input.workflowGateId;
  if (
    gate !== undefined &&
    (gate === DESIGN_REVIEW_FINAL_GATE_ID || matchesGate(gate, DEFAULT_BLOCKED_GATES))
  ) {
    return "blocked-gate";
  }
  return null;
}

/**
 * The proxy a relay attempt asks while the model is armed. It refuses what
 * `proxyRefusal` names before the model sees anything, and an answer that
 * comes back after the model was disarmed (learning turned off, another CLI
 * chosen, the threshold withdrawn) is an abstention: it no longer stands for
 * the person.
 */
function guardedProxy(
  model: DecisionModel,
  isArmed: () => boolean,
  disarmed: AbortSignal
): ProxyEngine {
  const engine = asBridgeEngine(model);
  return {
    gateAware: true,
    async suggest(input, timeout) {
      const refusal = proxyRefusal(input);
      if (refusal !== null) return abstain(refusal);
      if (!isArmed()) return abstain("model-off");
      const outcome = await engine.suggest(input, AbortSignal.any([timeout, disarmed]));
      return isArmed() ? outcome : abstain("model-off");
    },
  };
}

/** A stored evaluation that reads whole, or null: anything else counts as none, which arms nothing. */
export function parseDecisionModelEvaluation(raw: unknown): DecisionModelEvaluation | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const report = value.report as Record<string, unknown> | null | undefined;
  const calibration = report?.calibration as Record<string, unknown> | null | undefined;
  if (
    value.v !== 1 ||
    !(DECISIONS_MODEL_ADAPTERS as readonly unknown[]).includes(value.adapter) ||
    typeof value.evaluatedAt !== "number" ||
    !Number.isFinite(value.evaluatedAt) ||
    !(value.autoAnswerThreshold === null || isThreshold(value.autoAnswerThreshold)) ||
    typeof report !== "object" ||
    report === null ||
    typeof calibration !== "object" ||
    calibration === null ||
    !Array.isArray(calibration.points) ||
    typeof calibration.targetAccuracy !== "number" ||
    !Array.isArray(report.buckets)
  ) {
    return null;
  }
  // A file written by hand, or by an older build, could still name each question.
  const { items: _items, ...rest } = report;
  return {
    adapter: value.adapter as DecisionsModelAdapter,
    evaluatedAt: value.evaluatedAt,
    report: rest as unknown as DecisionModelEvaluation["report"],
    autoAnswerThreshold: value.autoAnswerThreshold as number | null,
  };
}

function readEvaluation(path: string): DecisionModelEvaluation | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== "ENOENT") {
      console.warn("[Decisions] The decision model's evaluation couldn't be read");
    }
    return null;
  }
  try {
    return parseDecisionModelEvaluation(JSON.parse(text));
  } catch {
    return null;
  }
}

async function writeEvaluation(path: string, evaluation: DecisionModelEvaluation): Promise<void> {
  await ensureOwnerOnlyDir(dirname(path));
  await resilientAtomicWriteFile(path, JSON.stringify({ v: 1, ...evaluation }), "utf-8", {
    mode: OWNER_RW_FILE_MODE,
  });
}

function withoutItems(report: EvaluationReport): DecisionModelEvaluation["report"] {
  const { items: _items, ...rest } = report;
  return rest;
}

/** What Settings shows of a running model (#16027). */
export interface DecisionModelSnapshot {
  /** The answers the history holds; null while it isn't open. */
  historyCount: number | null;
  evaluation: DecisionModelEvaluation | null;
  running: DecisionsModelRun | null;
  lastRun: DecisionsModelRunEnd | null;
  /** The confidence the armed proxy answers from, as the library honours it; null while unarmed. */
  answeringFrom: number | null;
}

interface ModelChoice {
  adapter: DecisionsModelAdapter;
  engine: DecisionModel;
}

interface Armed {
  model: DecisionModel;
  proxy: ProxyEngine;
  controller: AbortController;
}

/**
 * The decision model for one owner lifetime (#16026): its history, open only
 * while learning is on, and the proxy, armed only once learning is on, a CLI
 * is chosen, that CLI's evaluation is stored and the threshold the person
 * chose after it is one the evaluation supports. Nothing here runs while it
 * isn't armed: no question goes to the CLI just to be declined.
 *
 * The bridge offers the learner every answer a person gives from a phone
 * (never a proxy's, nor a person's confirmation of one), and the history
 * keeps it only while learning is on, with the library's secrets filter
 * applied before anything is written.
 */
export class DecisionModelRuntime {
  /** The same object for the lifetime, so every attempt's bridge can hold it whatever learning does. */
  readonly learner: DecisionLearner;

  private readonly files: DecisionModelFiles;
  private readonly onProxyChanged: () => void;
  private readonly onChanged: () => void;
  private readonly openHistory: (path: string) => HistoryStore;
  private readonly createAdapter: (adapter: DecisionsModelAdapter) => DecisionModelAdapter;
  private readonly now: () => number;
  private learning = false;
  private history: HistoryStore | null = null;
  private model: ModelChoice | null = null;
  private evaluation: DecisionModelEvaluation | null = null;
  private armed: Armed | null = null;
  /** Running evaluations, by the model each replays; null while one still waits its turn. */
  private readonly evaluations = new Map<AbortController, ModelChoice | null>();
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  /** The preferences last taken, which a cleared history opens again under. */
  private preferences: DecisionModelPreferences = { modelLearning: false, modelAdapter: null };
  /** The evaluation Settings started, while it runs. */
  private run: { info: DecisionsModelRun; controller: AbortController } | null = null;
  private lastRun: DecisionsModelRunEnd | null = null;

  constructor(options: DecisionModelRuntimeOptions) {
    this.files = options.files;
    this.onProxyChanged = options.onProxyChanged;
    this.onChanged = options.onChanged ?? (() => {});
    this.openHistory = options.openHistory ?? ((path) => new SqliteHistoryStore(path));
    this.createAdapter = options.createAdapter ?? ((adapter) => commandPresets[adapter]());
    this.now = options.now ?? Date.now;
    this.learner = { learn: (decision) => this.learn(decision) };
  }

  /** The proxy to ask while armed; null otherwise, and then nothing is asked. */
  proxy(): ProxyEngine | null {
    return this.armed?.proxy ?? null;
  }

  /** The evaluation stored for the chosen CLI; null while learning is off or none is. */
  getEvaluation(): DecisionModelEvaluation | null {
    const evaluation = this.evaluation;
    return evaluation !== null && evaluation.adapter === this.model?.adapter ? evaluation : null;
  }

  /** Takes the setting's preferences, in order with every other change. */
  update(preferences: DecisionModelPreferences): Promise<void> {
    return this.enqueue(() => this.apply(preferences));
  }

  /** Resolves once every change asked for so far has been taken, whether it worked or not. */
  settled(): Promise<void> {
    return this.enqueue(() => {});
  }

  /** What Settings shows of the model now. */
  snapshot(): DecisionModelSnapshot {
    return {
      historyCount: this.historyCount(),
      evaluation: this.getEvaluation(),
      running: this.run?.info ?? null,
      lastRun: this.lastRun,
      answeringFrom: this.armed === null ? null : this.armed.model.effectiveThreshold(),
    };
  }

  /**
   * Starts the evaluation Settings asked for, or answers the one already
   * running. It goes on when Settings closes, and ends at `cancelEvaluation`,
   * learning off, another CLI, a cleared history or close. Throws while
   * learning is off or no CLI is chosen.
   */
  startEvaluation(): DecisionsModelRun {
    if (this.run !== null) return this.run.info;
    const model = this.model;
    if (this.closed || this.history === null || model === null) {
      throw new Error("The decision model needs learning on and a CLI chosen to be evaluated");
    }
    const run = {
      info: {
        runId: randomUUID(),
        adapter: model.adapter,
        startedAt: this.now(),
        historyCount: this.historyCount() ?? 0,
      },
      controller: new AbortController(),
    };
    this.run = run;
    this.lastRun = null;
    // The run evaluates the model it names: a change queued before its turn cancels it.
    this.replay(run.controller.signal, model).then(
      () => this.endRun(run, null),
      (error: unknown) => {
        const cancelled = (error as Error | null)?.name === "AbortError";
        if (!cancelled) {
          console.warn(
            "[Decisions] The decision model's evaluation stopped:",
            error instanceof Error ? error.name : typeof error
          );
        }
        this.endRun(run, { runId: run.info.runId, result: cancelled ? "cancelled" : "failed" });
      }
    );
    this.notify();
    return run.info;
  }

  /** Cancels the evaluation Settings started if it is `runId`, so a late cancel can't end a newer one. */
  cancelEvaluation(runId: string): void {
    if (this.run?.info.runId === runId) this.run.controller.abort();
  }

  /**
   * Deletes what the model learned (#16027): the history with its SQLite
   * companions, and the evaluation, so nothing answers automatically until it
   * is evaluated again. Evaluations are cancelled first and the history closes
   * before its files go; with learning still on an empty one opens in its
   * place. The learner stays the same object and drops what it is offered
   * meanwhile.
   */
  clearHistory(): Promise<void> {
    if (this.closed) return Promise.reject(new Error("The decision model has stopped"));
    // Before its turn, so an evaluation waiting for one can't start on the history being deleted.
    for (const controller of this.evaluations.keys()) controller.abort();
    return this.enqueue(async () => {
      if (this.closed) throw new Error("The decision model has stopped");
      this.disarm(true);
      this.model = null;
      this.evaluation = null;
      this.closeHistory();
      let failure: unknown = null;
      try {
        await deleteDecisionModelFiles(this.files);
      } catch (error) {
        failure = error;
      }
      // Whatever was left opens again: the person sees it is still stored, and can clear it again.
      try {
        await this.apply(this.preferences);
      } catch (error) {
        console.warn(
          "[Decisions] The decision model's history didn't reopen after clearing:",
          error instanceof Error ? error.name : typeof error
        );
      }
      this.notify();
      if (failure !== null) throw failure;
    });
  }

  /**
   * Replays the history through the chosen CLI, one call per past answer, and
   * stores the report with no threshold chosen, which disarms the proxy until
   * the person chooses one after reading it. Rejects when learning is off, no
   * CLI is chosen, it was cancelled, or either changed while it ran.
   */
  evaluate(signal?: AbortSignal): Promise<DecisionModelEvaluation> {
    return this.replay(signal, null);
  }

  /** `evaluate`, or, with `expected`, a replay of that model alone: any other at its turn cancels it. */
  private async replay(
    signal: AbortSignal | undefined,
    expected: ModelChoice | null
  ): Promise<DecisionModelEvaluation> {
    // Held from the first moment, so a close while this waits its turn cancels it too.
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted || this.closed) cancel();
    this.evaluations.set(controller, null);
    try {
      const model = await this.enqueue(() => {
        if (controller.signal.aborted) throw evaluationCancelled();
        if (expected !== null && (this.history === null || this.model !== expected)) {
          throw evaluationCancelled();
        }
        if (this.history === null || this.model === null) {
          throw new Error("The decision model needs learning on and a CLI chosen to be evaluated");
        }
        // From here a change of CLI cancels it; one made before it got its turn is the one it evaluates.
        this.evaluations.set(controller, this.model);
        return this.model;
      });
      if (controller.signal.aborted) throw evaluationCancelled();
      const report = await model.engine.evaluate({ signal: controller.signal });
      return await this.enqueue(async () => {
        // A cancelled replay stops partway and reports what it reached, which proves nothing.
        if (controller.signal.aborted || this.closed || this.model !== model) {
          throw evaluationCancelled();
        }
        const evaluation: DecisionModelEvaluation = {
          adapter: model.adapter,
          // Later than the one it replaces, so a threshold chosen from that one names it alone.
          evaluatedAt: Math.max(this.now(), (this.evaluation?.evaluatedAt ?? 0) + 1),
          report: withoutItems(report),
          autoAnswerThreshold: null,
        };
        await writeEvaluation(this.files.evaluation, evaluation);
        this.evaluation = evaluation;
        this.rearm();
        this.notify();
        return evaluation;
      });
    } finally {
      this.evaluations.delete(controller);
      signal?.removeEventListener("abort", cancel);
    }
  }

  /**
   * Sets the confidence automatic answers need, for the stored evaluation of
   * the chosen CLI, or withdraws it with null. Only a threshold the
   * evaluation's calibration supports, as the library checks for exactly it,
   * is taken, so the one stored always arms the proxy. `evaluatedAt` names
   * the evaluation it was chosen from: one chosen from an older report is
   * refused.
   */
  setAutoAnswerThreshold(
    threshold: number | null,
    evaluatedAt?: number
  ): Promise<DecisionModelEvaluation> {
    return this.enqueue(async () => {
      const evaluation = this.getEvaluation();
      if (this.closed || evaluation === null) {
        throw new Error("The decision model needs an evaluation of the chosen CLI first");
      }
      if (evaluatedAt !== undefined && evaluatedAt !== evaluation.evaluatedAt) {
        throw staleEvaluation();
      }
      if (threshold !== null && !isThreshold(threshold)) {
        throw new Error("A threshold is a confidence from 0 to 1");
      }
      if (threshold !== null && !thresholdSupported(evaluation.report.calibration, threshold)) {
        throw new Error(
          "The evaluation doesn't support answering automatically from that confidence"
        );
      }
      const next: DecisionModelEvaluation = { ...evaluation, autoAnswerThreshold: threshold };
      await writeEvaluation(this.files.evaluation, next);
      this.evaluation = next;
      this.rearm();
      this.notify();
      return next;
    });
  }

  /**
   * Ends the runtime: the proxy disarms and evaluations stop at once, and the
   * history closes after any change in progress. Nothing is deleted. The
   * caller drops the relay connection itself, so no replacement is asked for.
   */
  close(): Promise<void> {
    this.closed = true;
    this.disarm(false);
    for (const controller of this.evaluations.keys()) controller.abort();
    return this.enqueue(() => {
      this.model = null;
      this.evaluation = null;
      this.closeHistory();
    });
  }

  private async apply(preferences: DecisionModelPreferences): Promise<void> {
    if (this.closed) return;
    const { modelLearning, modelAdapter } = preferences;
    this.preferences = { modelLearning, modelAdapter };
    this.learning = modelLearning;
    if (!modelLearning) {
      this.disarm(true);
      this.model = null;
      this.evaluation = null;
      this.cancelEvaluations();
      this.closeHistory();
      this.notify();
      return;
    }
    if (this.history === null) {
      await ensureOwnerOnlyDir(dirname(this.files.history));
      if (this.closed) return;
      const history = this.openHistory(this.files.history);
      try {
        tightenFilePermissionsSync(this.files.history);
        // The store keeps its own flag, which a file from an earlier lifetime may have off.
        history.setLearningEnabled(true);
      } catch (error) {
        history.close?.();
        throw error;
      }
      this.history = history;
      this.evaluation = readEvaluation(this.files.evaluation);
    }
    if ((this.model?.adapter ?? null) !== modelAdapter) {
      // An evaluation of the CLI chosen before says nothing of this one.
      this.cancelEvaluations();
      this.model =
        modelAdapter === null
          ? null
          : {
              adapter: modelAdapter,
              engine: createDecisionModel({
                history: this.history,
                adapter: this.createAdapter(modelAdapter),
              }),
            };
    }
    this.rearm();
    this.notify();
  }

  /**
   * Arms the proxy when everything it needs holds, and disarms it when
   * anything doesn't, telling the connection once either way. A threshold
   * change on the same model is taken in place: the armed proxy asks that
   * model, which reads its threshold on each answer.
   */
  private rearm(): void {
    const model = this.model;
    const evaluation = this.getEvaluation();
    if (model !== null) {
      model.engine.setCalibration(evaluation?.report.calibration ?? null);
      model.engine.setAutoAnswerThreshold(evaluation?.autoAnswerThreshold ?? null);
    }
    const authorised =
      !this.closed &&
      this.learning &&
      this.history !== null &&
      model !== null &&
      model.engine.effectiveThreshold() !== null;
    if (!authorised || model === null) {
      this.disarm(true);
      return;
    }
    if (this.armed?.model === model.engine) return;
    this.disarm(false);
    const controller = new AbortController();
    const armed: Armed = {
      model: model.engine,
      controller,
      proxy: guardedProxy(model.engine, () => this.armed === armed, controller.signal),
    };
    this.armed = armed;
    this.onProxyChanged();
  }

  private disarm(notify: boolean): void {
    const armed = this.armed;
    if (armed === null) return;
    this.armed = null;
    armed.controller.abort();
    if (notify) this.onProxyChanged();
  }

  /** Cancels the evaluations replaying a model, which a change of CLI or learning off just replaced. */
  private cancelEvaluations(): void {
    for (const [controller, model] of this.evaluations) if (model !== null) controller.abort();
  }

  private closeHistory(): void {
    const history = this.history;
    this.history = null;
    try {
      history?.close?.();
    } catch (error) {
      console.warn(
        "[Decisions] The decision model's history didn't close:",
        (error as Error)?.name
      );
    }
  }

  private learn(decision: LearnedDecision): unknown {
    const history = this.history;
    // A setup check's own test question is Daintree's, not one of the person's decisions.
    if (
      history === null ||
      this.closed ||
      !this.learning ||
      decision.projectId === SETUP_DIAGNOSTIC_PROJECT_ID
    ) {
      return undefined;
    }
    const result = asBridgeLearner(history).learn(decision);
    if (result.recorded && result.duplicate !== true) this.notify();
    return result;
  }

  private historyCount(): number | null {
    try {
      return this.history?.count() ?? null;
    } catch {
      return null;
    }
  }

  private endRun(
    run: { info: DecisionsModelRun; controller: AbortController },
    end: DecisionsModelRunEnd | null
  ): void {
    if (this.run !== run) return;
    this.run = null;
    this.lastRun = end;
    this.notify();
  }

  /** Tells Settings; nothing once closed, when no Settings reads this runtime again. */
  private notify(): void {
    if (this.closed) return;
    try {
      this.onChanged();
    } catch (error) {
      console.warn("[Decisions] A decision model listener threw:", (error as Error)?.name);
    }
  }

  private enqueue<T>(step: () => T | Promise<T>): Promise<T> {
    const run = this.queue.then(step);
    this.queue = run.catch(() => {});
    return run;
  }
}
