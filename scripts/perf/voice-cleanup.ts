import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { contentHash } from "../../e2e/helpers/voiceReplayScore";
import {
  buildCorrectionSystemPrompt,
  type VoiceReasoningEffort,
} from "../../shared/config/voiceCorrection";
import { formatErrorMessage } from "../../shared/utils/errorMessage";
import type {
  VoiceCorrectionRequest,
  VoiceCorrectionResult,
  VoiceCorrectionService as VoiceCorrectionServiceType,
  VoiceCorrectionSettings,
} from "../../electron/services/VoiceCorrectionService";
import { CLEANUP_CORPUS, type CleanupCase, type TranscriptStyle } from "./lib/voiceCleanupCorpus";
import {
  corpusProblems,
  locateUncertain,
  MODEL_PRICES,
  PROMPT_LENGTH_MIN_CHARS,
  requestCost,
  scoreText,
  SEND_WAIT_TARGET_MS,
  seededShuffle,
  summariseVariant,
  VOICE_CLEANUP_SCHEMA_VERSION,
  VOICE_CLEANUP_SCORING_VERSION,
  type Disposition,
  type LatencySummary,
  type QualitySummary,
  type Trial,
  type VariantSummary,
} from "./lib/voiceCleanupScore";
import { REPO_ROOT } from "./registry";

const RESULTS_DIR = path.join(REPO_ROOT, ".tmp", "perf-results", "voice-cleanup");
const MODEL_ALIASES: Readonly<Record<string, string>> = {
  luna: "gpt-6-luna",
  terra: "gpt-6.1-terra",
};
const EFFORTS: readonly VoiceReasoningEffort[] = ["none", "low", "medium", "high"];
const STYLES: readonly TranscriptStyle[] = ["openai", "deepgram", "generic"];

const USAGE = `usage: npm run perf voice-cleanup -- [options]

Runs every corpus passage through the real VoiceCorrectionService, once per
model and effort, against the live OpenAI API (needs OPENAI_API_KEY; costs money).

  --variants <list>     model:effort pairs (default luna:none,terra:none,terra:low);
                        luna and terra are aliases, any other model id is sent as is
  --repeats <n>         passes over the corpus (default 1)
  --cases <list>        only cases whose id starts with one of these
  --styles <list>       only these transcript styles (${STYLES.join(", ")})
  --seed <n>            request order seed (default 14793)
  --label <name>        result file prefix (default run)
  --probe-prediction    also ask each model for Predicted Outputs and record the answer
  --rescore <run.json>  score a saved run again with today's corpus and scoring, sending nothing`;

interface Variant {
  id: string;
  model: string;
  effort: VoiceReasoningEffort;
}

interface Options {
  variants: Variant[];
  repeats: number;
  cases: string[];
  styles: TranscriptStyle[];
  seed: number;
  label: string;
  probePrediction: boolean;
  rescore: string | null;
}

function parseVariant(spec: string): Variant {
  const [name = "", effort = "none", ...extra] = spec.trim().split(":");
  const model = MODEL_ALIASES[name] ?? name;
  if (!model || extra.length > 0) throw new Error(`bad variant "${spec}": expected model:effort`);
  if (!EFFORTS.includes(effort as VoiceReasoningEffort)) {
    throw new Error(`bad effort "${effort}" in "${spec}": one of ${EFFORTS.join(", ")}`);
  }
  return { id: `${model}:${effort}`, model, effort: effort as VoiceReasoningEffort };
}

function parseArgs(argv: readonly string[]): Options | null {
  const options: Options = {
    variants: ["luna:none", "terra:none", "terra:low"].map(parseVariant),
    repeats: 1,
    cases: [],
    styles: [...STYLES],
    seed: 14793,
    label: "run",
    probePrediction: false,
    rescore: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${flag} needs a value`);
      return next;
    };
    const list = () =>
      value()
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
    const count = (min: number) => {
      const n = Number(value());
      if (!Number.isInteger(n) || n < min) throw new Error(`${flag} needs an integer >= ${min}`);
      return n;
    };
    switch (flag) {
      case "--help":
      case "-h":
        return null;
      case "--variants":
        options.variants = list().map(parseVariant);
        break;
      case "--repeats":
        options.repeats = count(1);
        break;
      case "--cases":
        options.cases = list();
        break;
      case "--styles": {
        const styles = list();
        const unknown = styles.filter((style) => !STYLES.includes(style as TranscriptStyle));
        if (unknown.length) throw new Error(`unknown style(s): ${unknown.join(", ")}`);
        options.styles = styles as TranscriptStyle[];
        break;
      }
      case "--seed":
        options.seed = count(0);
        break;
      case "--label":
        options.label = value().replace(/[^\w.-]+/g, "-");
        break;
      case "--probe-prediction":
        options.probePrediction = true;
        break;
      case "--rescore":
        options.rescore = value();
        break;
      default:
        throw new Error(`unknown option ${flag}`);
    }
  }
  if (new Set(options.variants.map((variant) => variant.id)).size !== options.variants.length) {
    throw new Error("a variant is listed twice");
  }
  return options;
}

// Kept identical across variants: the project hints production sends, with no
// dictionary, names or command target, so every passage has the same context.
const PROFILE = {
  customDictionary: [] as string[],
  projectName: "daintree",
  projectPath: "/Users/dev/Projects/daintree",
  language: "en",
};

function settingsFor(variant: Variant, apiKey: string): VoiceCorrectionSettings {
  return {
    ...PROFILE,
    model: variant.model,
    reasoningEffort: variant.effort,
    apiKey,
    ...(process.env.OPENAI_ORG_ID ? { organizationId: process.env.OPENAI_ORG_ID } : {}),
    ...(process.env.OPENAI_PROJECT_ID ? { projectId: process.env.OPENAI_PROJECT_ID } : {}),
  };
}

function requestFor(entry: CleanupCase): VoiceCorrectionRequest {
  const recentContext = entry.recentContext ?? [];
  return {
    rawText: entry.raw,
    ...(recentContext.length > 0 ? { recentContext } : {}),
    ...(entry.terminalOutput ? { terminalOutput: entry.terminalOutput } : {}),
    reason: "stop",
    startsPrompt: entry.startsPrompt ?? recentContext.length === 0,
    ...(entry.uncertain?.length ? { uncertain: locateUncertain(entry.raw, entry.uncertain) } : {}),
  };
}

function dispositionOf(result: VoiceCorrectionResult): Disposition {
  if (result.failed) return "failed";
  if (result.rejected) return "rejected";
  if (!result.roundTrip) return "skipped";
  return result.action === "replace" ? "applied" : "declined";
}

function toTrial(
  entry: CleanupCase,
  variant: Variant,
  repeat: number,
  result: VoiceCorrectionResult,
  totalMs: number
): Trial {
  const landed = result.confirmedText;
  const proposal = result.rejected?.candidate ?? landed;
  const usage = result.roundTrip?.usage;
  return {
    caseId: entry.id,
    variant: variant.id,
    repeat,
    disposition: dispositionOf(result),
    ...(result.rejected ? { rejectReason: result.rejected.reason } : {}),
    landed,
    proposal,
    landedScore: scoreText(entry, landed),
    proposalScore: scoreText(entry, proposal),
    roundTripMs: result.roundTrip ? Math.round(result.roundTrip.ms) : null,
    totalMs: Math.round(totalMs),
    ...(usage ? { usage } : {}),
    costUsd: requestCost(variant.model, usage),
  };
}

interface PredictionProbe {
  model: string;
  endpoint: "responses" | "chat/completions";
  status: number | null;
  code: string | null;
}

// One request per endpoint asking for Predicted Outputs alongside the strict
// JSON format cleanup uses, recording only whether the API took it.
async function probePredictedOutputs(model: string, apiKey: string): Promise<PredictionProbe[]> {
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: { corrected_text: { type: "string" } },
    required: ["corrected_text"],
  };
  const text = "Commit and push.";
  const prediction = { type: "content", content: JSON.stringify({ corrected_text: text }) };
  const requests: Array<[PredictionProbe["endpoint"], Record<string, unknown>]> = [
    [
      "responses",
      {
        model,
        input: [{ role: "user", content: text }],
        reasoning: { effort: "none" },
        text: { format: { type: "json_schema", name: "probe", strict: true, schema } },
        prediction,
        store: false,
      },
    ],
    [
      "chat/completions",
      {
        model,
        messages: [{ role: "user", content: text }],
        response_format: {
          type: "json_schema",
          json_schema: { name: "probe", strict: true, schema },
        },
        prediction,
        store: false,
      },
    ],
  ];
  const probes: PredictionProbe[] = [];
  for (const [endpoint, body] of requests) {
    try {
      const response = await fetch(`https://api.openai.com/v1/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
      });
      const data = (await response.json().catch(() => ({}))) as { error?: { code?: unknown } };
      const code = typeof data.error?.code === "string" ? data.error.code : null;
      probes.push({ model, endpoint, status: response.status, code });
    } catch {
      probes.push({ model, endpoint, status: null, code: "network_error" });
    }
  }
  return probes;
}

function git(args: string[]): string {
  try {
    return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
const ms = (value: number | null) => (value === null ? "–" : `${Math.round(value)}`);
const usd = (value: number | null, digits = 5) =>
  value === null ? "–" : `$${value.toFixed(digits)}`;

function qualityRow(variant: string, quality: QualitySummary): string {
  const { totals } = quality;
  const rate = (value: number, of: number) => (of === 0 ? "–" : pct(value));
  return `| ${variant} | ${rate(quality.repairRate, totals.repairable)} | ${rate(quality.fixRate, totals.fixes)} | ${rate(quality.dropRate, totals.drops)} | ${rate(quality.keepRate, totals.keeps)} | ${pct(quality.referenceMatchRate)} | ${pct(quality.rawWer)} → ${pct(quality.wer)} | ${quality.broken} | ${quality.novelWords} | ${quality.trialsWithMeaningRisk} |`;
}

function latencyCells(latency: LatencySummary): string {
  if (latency.count === 0) return "– | – | – | –";
  return `${ms(latency.p50)} | ${ms(latency.p95)} | ${ms(latency.max)} | ${pct(latency.overTarget)}`;
}

interface RunRecord {
  schemaVersion: number;
  scoringVersion: number;
  complete: boolean;
  label: string;
  startedAt: string;
  finishedAt: string | null;
  git: { revision: string; dirty: boolean };
  node: string;
  platform: string;
  seed: number;
  repeats: number;
  variants: Variant[];
  profile: typeof PROFILE;
  promptHash: string;
  corpusHash: string;
  corpus: Array<{ id: string; style: TranscriptStyle; source: string; chars: number }>;
  prices: typeof MODEL_PRICES;
  predictionProbes: PredictionProbe[];
  trials: Trial[];
  summaries: VariantSummary[];
}

function renderReport(run: RunRecord, corpus: readonly CleanupCase[]): string {
  const lines: string[] = [];
  const longCases = corpus.filter((entry) => entry.raw.length >= PROMPT_LENGTH_MIN_CHARS).length;
  lines.push(
    `# Dictation cleanup benchmark: ${run.label}`,
    "",
    `${run.startedAt} · ${run.git.revision.slice(0, 10)}${run.git.dirty ? " (dirty)" : ""} · ${corpus.length} passages (${longCases} of ${PROMPT_LENGTH_MIN_CHARS}+ chars) × ${run.repeats} repeat(s) · seed ${run.seed}${run.complete ? "" : " · **incomplete**"}`,
    "",
    "## What landed",
    "",
    "The text the service handed back, the checks applied. Repaired: reference words the raw transcript had wrong that came back right. Fixes: written forms landed exactly. Broken: words the raw had right that were lost or changed. Novel: words in neither the raw nor the reference. Risky trials: any broken or novel word.",
    "",
    "| Variant | Repaired | Fixes | Drops | Keeps | Matches ref | WER raw → clean | Broken | Novel | Risky trials |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...run.summaries.map((summary) => qualityRow(summary.variant, summary.landed)),
    "",
    "## What the model proposed",
    "",
    "Before the guards: the rejected candidates scored as if they had landed.",
    "",
    "| Variant | Repaired | Fixes | Drops | Keeps | Matches ref | WER raw → clean | Broken | Novel | Risky trials |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...run.summaries.map((summary) => qualityRow(summary.variant, summary.proposed)),
    "",
    "## Dispositions",
    "",
    "| Variant | Applied | Declined | Rejected | Failed | Skipped | Reject reasons | Clean passages untouched |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...run.summaries.map((summary) => {
      const d = summary.dispositions;
      const reasons =
        Object.entries(summary.rejectReasons)
          .sort((a, b) => b[1] - a[1])
          .map(([reason, n]) => `${reason} ${n}`)
          .join(", ") || "–";
      return `| ${summary.variant} | ${d.applied} | ${d.declined} | ${d.rejected} | ${d.failed} | ${d.skipped} | ${reasons} | ${summary.cleanUntouched.kept}/${summary.cleanUntouched.of} |`;
    }),
    "",
    "## Latency (ms)",
    "",
    `Round trip is the service's own: request out to reply read. Total is all of \`correct()\`. Over target: share above ${SEND_WAIT_TARGET_MS} ms.`,
    "",
    "| Variant | p50 | p95 | max | over target | prompt-length p50 | p95 | max | over target | total p50 | total p95 |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...run.summaries.map(
      (summary) =>
        `| ${summary.variant} | ${latencyCells(summary.roundTrip)} | ${latencyCells(summary.promptLengthRoundTrip)} | ${ms(summary.total.p50)} | ${ms(summary.total.p95)} |`
    ),
    "",
    "## Tokens and cost",
    "",
    "| Variant | Mean input | Cached | Mean output | Mean reasoning | Cache writes | Per cleanup | Run total |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...run.summaries.map(
      (summary) =>
        `| ${summary.variant} | ${Math.round(summary.tokens.meanInput)} | ${pct(summary.tokens.cachedShare)} | ${Math.round(summary.tokens.meanOutput)} | ${Math.round(summary.tokens.meanReasoning)} | ${summary.tokens.cacheWrites} | ${usd(summary.meanCostUsd)} | ${usd(summary.totalCostUsd, 3)} |`
    ),
    ""
  );

  const groups: Array<[string, (entry: CleanupCase) => string]> = [
    ["source", (entry) => entry.source],
    ["style", (entry) => entry.style],
  ];
  const byId = new Map(corpus.map((entry) => [entry.id, entry]));
  for (const [name, key] of groups) {
    const values = [...new Set(corpus.map(key))];
    lines.push(
      `## Fixes landed and reference matches by ${name}`,
      "",
      `| ${name} | passages | ${run.variants.map((variant) => variant.id).join(" | ")} |`,
      `| --- | --- | ${run.variants.map(() => "---").join(" | ")} |`
    );
    for (const value of values) {
      const cells = run.variants.map((variant) => {
        const rows = run.trials.filter(
          (trial) => trial.variant === variant.id && key(byId.get(trial.caseId)!) === value
        );
        const fixes = rows.reduce((n, trial) => n + byId.get(trial.caseId)!.fixes.length, 0);
        const landed = rows.reduce((n, trial) => n + trial.landedScore.fixesLanded, 0);
        const matches = rows.filter((trial) => trial.landedScore.matchesReference).length;
        return `${fixes ? `${landed}/${fixes}` : "–"} · ${matches}/${rows.length}`;
      });
      const count = corpus.filter((entry) => key(entry) === value).length;
      lines.push(`| ${value} | ${count} | ${cells.join(" | ")} |`);
    }
    lines.push("");
  }

  if (run.predictionProbes.length > 0) {
    lines.push(
      "## Predicted Outputs",
      "",
      "| Model | Endpoint | Status | Code |",
      "| --- | --- | --- | --- |",
      ...run.predictionProbes.map(
        (probe) =>
          `| ${probe.model} | ${probe.endpoint} | ${probe.status ?? "–"} | ${probe.code ?? "accepted"} |`
      ),
      ""
    );
  }

  // Where the variants landed something different on the first pass: the
  // passages to read by hand, since no word score sees a reversed meaning.
  const differing = corpus.filter((entry) => {
    const landed = run.variants.map(
      (variant) =>
        run.trials.find(
          (trial) => trial.caseId === entry.id && trial.variant === variant.id && trial.repeat === 1
        )?.landed
    );
    return new Set(landed).size > 1;
  });
  lines.push(`## Where the variants differ (first pass, ${differing.length} passages)`, "");
  for (const entry of differing) {
    lines.push(
      `### ${entry.id}`,
      "",
      `- raw: ${JSON.stringify(entry.raw)}`,
      `- reference: ${JSON.stringify(entry.reference)}`
    );
    for (const variant of run.variants) {
      const trial = run.trials.find(
        (candidate) =>
          candidate.caseId === entry.id &&
          candidate.variant === variant.id &&
          candidate.repeat === 1
      );
      if (!trial) continue;
      const notes = [
        trial.disposition + (trial.rejectReason ? ` (${trial.rejectReason})` : ""),
        trial.landedScore.missedFixes.length
          ? `missed ${trial.landedScore.missedFixes.join(", ")}`
          : "",
        trial.landedScore.lostKeeps.length ? `lost ${trial.landedScore.lostKeeps.join(", ")}` : "",
        trial.landedScore.broken ? `${trial.landedScore.broken} broken` : "",
        trial.landedScore.novelWords ? `${trial.landedScore.novelWords} novel` : "",
      ].filter(Boolean);
      const proposed =
        trial.disposition === "rejected" ? ` — proposed ${JSON.stringify(trial.proposal)}` : "";
      lines.push(
        `- ${variant.id}: ${JSON.stringify(trial.landed)} (${notes.join("; ")})${proposed}`
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}

// The passages a saved run sent, as the corpus has them today, with every
// trial scored again. Passages since removed from the corpus drop out.
function rescore(file: string): { run: RunRecord; corpus: CleanupCase[] } {
  const run = JSON.parse(readFileSync(file, "utf8")) as RunRecord;
  if (run.schemaVersion !== VOICE_CLEANUP_SCHEMA_VERSION) {
    throw new Error(
      `${file}: schema ${run.schemaVersion}, this script reads ${VOICE_CLEANUP_SCHEMA_VERSION}`
    );
  }
  const current = new Map(CLEANUP_CORPUS.map((entry) => [entry.id, entry]));
  const corpus = run.corpus.flatMap(({ id }) => current.get(id) ?? []);
  const kept = new Set(corpus.map((entry) => entry.id));
  run.trials = run.trials
    .filter((trial) => kept.has(trial.caseId))
    .map((trial) => {
      const entry = current.get(trial.caseId)!;
      return {
        ...trial,
        landedScore: scoreText(entry, trial.landed),
        proposalScore: scoreText(entry, trial.proposal),
      };
    });
  run.scoringVersion = VOICE_CLEANUP_SCORING_VERSION;
  run.summaries = run.variants.map((variant) => summariseVariant(variant.id, run.trials, corpus));
  return { run, corpus };
}

async function main(): Promise<number> {
  let options: Options | null;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[voice-cleanup] ${formatErrorMessage(error)}\n\n${USAGE}`);
    return 1;
  }
  if (!options) {
    console.log(USAGE);
    return 0;
  }

  if (options.rescore) {
    const { run, corpus } = rescore(options.rescore);
    const report = renderReport(run, corpus);
    const out = options.rescore.replace(/\.json$/, "") + "-rescored.md";
    writeFileSync(out, `${report}\n`);
    console.log(report);
    console.error(`\n[voice-cleanup] wrote ${path.relative(REPO_ROOT, path.resolve(out))}`);
    return 0;
  }

  const problems = corpusProblems(CLEANUP_CORPUS);
  if (problems.length > 0) {
    console.error(`[voice-cleanup] the corpus has problems:\n  ${problems.join("\n  ")}`);
    return 1;
  }
  const { cases, styles } = options;
  const corpus = CLEANUP_CORPUS.filter(
    (entry) =>
      styles.includes(entry.style) &&
      (cases.length === 0 || cases.some((prefix) => entry.id.startsWith(prefix)))
  );
  if (corpus.length === 0) {
    console.error("[voice-cleanup] no passage matches --cases/--styles");
    return 1;
  }

  const apiKey = process.env.OPENAI_API_KEY ?? "";
  if (!apiKey) {
    console.error("[voice-cleanup] OPENAI_API_KEY is not set");
    return 1;
  }

  // The service's logger decides at load whether to write log files into the
  // working directory, so this has to be set before it is imported.
  process.env.DAINTREE_DISABLE_FILE_LOGGING = "1";
  const { VoiceCorrectionService } = await import("../../electron/services/VoiceCorrectionService");

  const startedAt = new Date();
  const stamp = startedAt.toISOString().replace(/[:.]/g, "-");
  mkdirSync(RESULTS_DIR, { recursive: true });
  const jsonPath = path.join(RESULTS_DIR, `${options.label}-${stamp}.json`);
  const markdownPath = jsonPath.replace(/\.json$/, ".md");

  const run: RunRecord = {
    schemaVersion: VOICE_CLEANUP_SCHEMA_VERSION,
    scoringVersion: VOICE_CLEANUP_SCORING_VERSION,
    complete: false,
    label: options.label,
    startedAt: startedAt.toISOString(),
    finishedAt: null,
    git: { revision: git(["rev-parse", "HEAD"]), dirty: git(["status", "--porcelain"]) !== "" },
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    seed: options.seed,
    repeats: options.repeats,
    variants: options.variants,
    profile: PROFILE,
    promptHash: contentHash(buildCorrectionSystemPrompt(PROFILE)),
    corpusHash: contentHash(JSON.stringify(corpus)),
    corpus: corpus.map((entry) => ({
      id: entry.id,
      style: entry.style,
      source: entry.source,
      chars: entry.raw.length,
    })),
    prices: MODEL_PRICES,
    predictionProbes: [],
    trials: [],
    summaries: [],
  };
  const save = () => {
    run.summaries = options.variants.map((variant) =>
      summariseVariant(variant.id, run.trials, corpus)
    );
    writeFileSync(jsonPath, `${JSON.stringify(run, null, 2)}\n`);
  };

  if (options.probePrediction) {
    for (const model of new Set(options.variants.map((variant) => variant.model))) {
      run.predictionProbes.push(...(await probePredictedOutputs(model, apiKey)));
    }
  }

  const services = new Map<string, VoiceCorrectionServiceType>(
    options.variants.map((variant) => [variant.id, new VoiceCorrectionService()])
  );
  // Production warms the prompt while the user dictates; so does this, once.
  for (const variant of options.variants) {
    await services.get(variant.id)!.warm(settingsFor(variant, apiKey));
  }

  const total = corpus.length * options.variants.length * options.repeats;
  console.error(
    `[voice-cleanup] ${total} requests: ${corpus.length} passages × ${options.variants.length} variants × ${options.repeats} repeat(s)`
  );
  let done = 0;
  for (let repeat = 1; repeat <= options.repeats; repeat++) {
    const order = seededShuffle(corpus, options.seed + repeat);
    for (const [index, entry] of order.entries()) {
      const variants = seededShuffle(options.variants, options.seed * 7919 + repeat * 1009 + index);
      for (const variant of variants) {
        const service = services.get(variant.id)!;
        // As a stop drains, so a reply never waits on a fresh handshake.
        service.preconnect();
        const started = performance.now();
        const result = await service.correct(requestFor(entry), settingsFor(variant, apiKey));
        run.trials.push(toTrial(entry, variant, repeat, result, performance.now() - started));
        done++;
      }
      save();
      if (done % 30 < options.variants.length || done === total) {
        console.error(`[voice-cleanup] ${done}/${total}`);
      }
    }
  }

  run.complete = true;
  run.finishedAt = new Date().toISOString();
  save();
  const report = renderReport(run, corpus);
  writeFileSync(markdownPath, `${report}\n`);
  console.log(report);
  console.error(`\n[voice-cleanup] wrote ${path.relative(REPO_ROOT, jsonPath)} and .md`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error("[voice-cleanup] fatal:", error);
    process.exit(1);
  }
);
