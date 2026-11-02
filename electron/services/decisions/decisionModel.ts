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
  asBridgeEngine,
  asBridgeLearner,
  commandPresets,
  createDecisionModel,
  matchesGate,
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
import {
  OWNER_RW_FILE_MODE,
  ensureOwnerOnlyDir,
  resilientAtomicWriteFile,
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
    typeof calibration.targetAccuracy !== "number"
  ) {
    return null;
  }
  return {
    adapter: value.adapter as DecisionsModelAdapter,
    evaluatedAt: value.evaluatedAt,
    report: report as unknown as DecisionModelEvaluation["report"],
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
  private readonly openHistory: (path: string) => HistoryStore;
  private readonly createAdapter: (adapter: DecisionsModelAdapter) => DecisionModelAdapter;
  private readonly now: () => number;
  private learning = false;
  private history: HistoryStore | null = null;
  private model: { adapter: DecisionsModelAdapter; engine: DecisionModel } | null = null;
  private evaluation: DecisionModelEvaluation | null = null;
  private armed: Armed | null = null;
  private readonly evaluations = new Set<AbortController>();
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(options: DecisionModelRuntimeOptions) {
    this.files = options.files;
    this.onProxyChanged = options.onProxyChanged;
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

  /**
   * Replays the history through the chosen CLI, one call per past answer, and
   * stores the report with no threshold chosen, which disarms the proxy until
   * the person chooses one after reading it. Rejects when learning is off, no
   * CLI is chosen, it was cancelled, or either changed while it ran.
   */
  async evaluate(signal?: AbortSignal): Promise<DecisionModelEvaluation> {
    const model = await this.enqueue(() => {
      if (this.closed || this.history === null || this.model === null) {
        throw new Error("The decision model needs learning on and a CLI chosen to be evaluated");
      }
      return this.model;
    });
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    this.evaluations.add(controller);
    try {
      const report = await model.engine.evaluate({ signal: controller.signal });
      return await this.enqueue(async () => {
        // A cancelled replay stops partway and reports what it reached, which proves nothing.
        if (controller.signal.aborted || this.closed || this.model !== model) {
          throw new Error("The decision model's evaluation was cancelled");
        }
        const evaluation: DecisionModelEvaluation = {
          adapter: model.adapter,
          evaluatedAt: this.now(),
          report: withoutItems(report),
          autoAnswerThreshold: null,
        };
        await writeEvaluation(this.files.evaluation, evaluation);
        this.evaluation = evaluation;
        this.rearm();
        return evaluation;
      });
    } finally {
      this.evaluations.delete(controller);
      signal?.removeEventListener("abort", cancel);
    }
  }

  /**
   * Sets the confidence automatic answers need, for the stored evaluation of
   * the chosen CLI, or withdraws it with null. The proxy arms only if the
   * evaluation's calibration supports exactly this threshold.
   */
  setAutoAnswerThreshold(threshold: number | null): Promise<DecisionModelEvaluation> {
    return this.enqueue(async () => {
      const evaluation = this.getEvaluation();
      if (this.closed || evaluation === null) {
        throw new Error("The decision model needs an evaluation of the chosen CLI first");
      }
      if (threshold !== null && !isThreshold(threshold)) {
        throw new Error("A threshold is a confidence from 0 to 1");
      }
      const next: DecisionModelEvaluation = { ...evaluation, autoAnswerThreshold: threshold };
      await writeEvaluation(this.files.evaluation, next);
      this.evaluation = next;
      this.rearm();
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
    for (const controller of this.evaluations) controller.abort();
    return this.enqueue(() => {
      this.model = null;
      this.evaluation = null;
      this.closeHistory();
    });
  }

  private async apply({ modelLearning, modelAdapter }: DecisionModelPreferences): Promise<void> {
    if (this.closed) return;
    this.learning = modelLearning;
    if (!modelLearning) {
      this.disarm(true);
      this.model = null;
      this.evaluation = null;
      this.cancelEvaluations();
      this.closeHistory();
      return;
    }
    if (this.history === null) {
      await ensureOwnerOnlyDir(dirname(this.files.history));
      if (this.closed) return;
      const history = this.openHistory(this.files.history);
      tightenFilePermissionsSync(this.files.history);
      // The store keeps its own flag, which a file from an earlier lifetime may have off.
      history.setLearningEnabled(true);
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

  private cancelEvaluations(): void {
    for (const controller of this.evaluations) controller.abort();
  }

  private closeHistory(): void {
    const history = this.history;
    this.history = null;
    try {
      history?.close?.();
    } catch (error) {
      console.warn("[Decisions] The decision model's history didn't close:", (error as Error)?.name);
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
    return asBridgeLearner(history).learn(decision);
  }

  private enqueue<T>(step: () => T | Promise<T>): Promise<T> {
    const run = this.queue.then(step);
    this.queue = run.catch(() => {});
    return run;
  }
}
