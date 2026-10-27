import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { contentHash } from "../../e2e/helpers/voiceReplayScore";
import {
  buildCorrectionSystemPrompt,
  type CorrectionInstructions,
  type VoiceReasoningEffort,
} from "../../shared/config/voiceCorrection";
import { formatErrorMessage } from "../../shared/utils/errorMessage";
import { buildOpenAIHeaders } from "../../shared/utils/openaiHeaders";
import { getAgentConfig } from "../../shared/config/agentRegistry";
import { getBuiltinSlashCommands } from "../../shared/types/slashCommands";
import {
  buildVoiceCommandVocabulary,
  EMPTY_VOICE_COMMAND_VOCABULARY,
  type VoiceCommandVocabulary,
} from "../../shared/utils/voiceAgentCommands";
import type { VoiceCommandTarget } from "../../electron/services/voiceCommandTarget";
import type {
  VoiceCorrectionRequest,
  VoiceCorrectionResult,
  VoiceCorrectionService as VoiceCorrectionServiceType,
  VoiceCorrectionSettings,
} from "../../electron/services/VoiceCorrectionService";
import { CORRECTION_GUARD_LIMITS } from "../../electron/services/voiceCorrectionGuard";
import {
  correctionOutcome,
  type VoiceCorrectionProposal,
} from "../../electron/services/voiceCorrectionOutcome";
import {
  CLEANUP_CORPUS,
  cleanupSessions,
  FIX_KINDS,
  recentPromptTwins,
  type CleanupCase,
  type CleanupSession,
  type FixKind,
  type TranscriptStyle,
} from "./lib/voiceCleanupCorpus";
import { ADVERSARIAL_PROPOSALS, GUARD_VARIANTS, type GuardVariant } from "./lib/voiceCleanupGuards";
import { PROMPT_VARIANTS } from "./lib/voiceCleanupPrompts";
import {
  corpusProblems,
  fixesOf,
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
  type Landing,
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
const STYLES: readonly TranscriptStyle[] = ["openai", "deepgram", "grok", "generic"];

const USAGE = `usage: npm run perf voice-cleanup -- [options]

Runs every corpus passage through the real VoiceCorrectionService, once per
model and effort, against the live OpenAI API (needs OPENAI_API_KEY; costs money).

  --variants <list>     model:effort pairs (default terra:none);
                        luna and terra are aliases, any other model id is sent as is
  --prompts <list>      cleanup prompts, each run with every model:effort (default
                        production): ${Object.keys(PROMPT_VARIANTS).join(", ")}
  --guards <list>       edit budgets every reply is landed under, sending nothing more
                        (default v11,production): ${Object.keys(GUARD_VARIANTS).join(", ")}
  --repeats <n>         passes over the corpus (default 1)
  --cases <list>        only cases whose id starts with one of these
  --styles <list>       only these transcript styles (${STYLES.join(", ")})
  --dictionary <list>   custom dictionary terms, the same for every variant (default none)
  --seed <n>            request order seed (default 14793)
  --label <name>        result file prefix (default run)
  --no-stream           ask for the whole reply at once, as cleanup did before it streamed
  --probe-prediction    also ask each model for Predicted Outputs and record the answer
  --rescore <run.json>  score a saved run again with today's corpus and scoring, sending
                        nothing, landing its replies under --guards when given`;

interface Variant {
  /** `model:effort/prompt`. */
  id: string;
  model: string;
  effort: VoiceReasoningEffort;
  prompt: string;
}

interface Options {
  variants: Variant[];
  guards: string[] | null;
  repeats: number;
  cases: string[];
  styles: TranscriptStyle[];
  dictionary: string[];
  seed: number;
  label: string;
  probePrediction: boolean;
  stream: boolean;
  rescore: string | null;
}

function parseModel(spec: string): Omit<Variant, "id" | "prompt"> {
  const [name = "", effort = "none", ...extra] = spec.trim().split(":");
  const model = MODEL_ALIASES[name] ?? name;
  if (!model || extra.length > 0) throw new Error(`bad variant "${spec}": expected model:effort`);
  if (!EFFORTS.includes(effort as VoiceReasoningEffort)) {
    throw new Error(`bad effort "${effort}" in "${spec}": one of ${EFFORTS.join(", ")}`);
  }
  return { model, effort: effort as VoiceReasoningEffort };
}

function namesIn(registry: Readonly<Record<string, unknown>>, kind: string, names: string[]) {
  if (names.length === 0) throw new Error(`no ${kind} named`);
  const unknown = names.filter((name) => !Object.hasOwn(registry, name));
  if (unknown.length) {
    throw new Error(
      `unknown ${kind}(s): ${unknown.join(", ")}; one of ${Object.keys(registry).join(", ")}`
    );
  }
  if (new Set(names).size !== names.length) throw new Error(`a ${kind} is listed twice`);
  return names;
}

function parseArgs(argv: readonly string[]): Options | null {
  let models = [parseModel("terra:none")];
  let prompts = ["production"];
  const options: Options = {
    variants: [],
    guards: null,
    repeats: 1,
    cases: [],
    styles: [...STYLES],
    dictionary: [],
    seed: 14793,
    label: "run",
    probePrediction: false,
    stream: true,
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
        models = list().map(parseModel);
        break;
      case "--prompts":
        prompts = namesIn(PROMPT_VARIANTS, "prompt", list());
        break;
      case "--guards":
        options.guards = namesIn(GUARD_VARIANTS, "guard", list());
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
      case "--dictionary":
        options.dictionary = list();
        break;
      case "--seed":
        options.seed = count(0);
        break;
      case "--label":
        options.label = value().replace(/[^\w.-]+/g, "-");
        break;
      case "--no-stream":
        options.stream = false;
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
  options.variants = models.flatMap((model) =>
    prompts.map((prompt) => ({
      ...model,
      prompt,
      id: `${model.model}:${model.effort}/${prompt}`,
    }))
  );
  if (options.variants.length === 0) throw new Error("--variants or --prompts names nothing");
  if (new Set(options.variants.map((variant) => variant.id)).size !== options.variants.length) {
    throw new Error("a variant is listed twice");
  }
  return options;
}

// Kept identical across variants: the project hints production sends and the
// agent the passage is typed into, with no workspace names. A passage's session
// adds its worktree and repository names on top, as production's does for a
// pane on this machine.
interface Profile {
  customDictionary: string[];
  projectName: string;
  projectPath: string;
  language: string;
  /** Absent in runs from before #14786's second round, which sent no target. */
  commandTarget?: VoiceCommandTarget;
}

function vocabularyOf(profile: Profile): VoiceCommandVocabulary {
  return profile.commandTarget?.vocabulary ?? EMPTY_VOICE_COMMAND_VOCABULARY;
}

/** Claude Code with its built-in commands, as production describes a terminal running it. */
function claudeCodeTarget(): VoiceCommandTarget {
  const config = getAgentConfig("claude")!;
  return {
    agentId: "claude",
    agentName: config.name,
    isAssistant: false,
    vocabulary: buildVoiceCommandVocabulary(
      getBuiltinSlashCommands("claude"),
      config.completionSources ?? []
    ),
  };
}

function profileFor(options: Options): Profile {
  return {
    customDictionary: options.dictionary,
    projectName: "daintree",
    projectPath: "/Users/dev/Projects/daintree",
    language: "en",
    commandTarget: claudeCodeTarget(),
  };
}

const ROUTING = {
  ...(process.env.OPENAI_ORG_ID ? { organizationId: process.env.OPENAI_ORG_ID } : {}),
  ...(process.env.OPENAI_PROJECT_ID ? { projectId: process.env.OPENAI_PROJECT_ID } : {}),
};

function instructionsOf(variant: Variant) {
  return PROMPT_VARIANTS[variant.prompt]!.instructionsFor(variant.model);
}

function settingsFor(
  variant: Variant,
  profile: Profile,
  apiKey: string,
  session: CleanupSession | undefined
): VoiceCorrectionSettings {
  return {
    ...profile,
    ...session,
    model: variant.model,
    reasoningEffort: variant.effort,
    instructions: instructionsOf(variant),
    apiKey,
    ...ROUTING,
  };
}

function requestFor(entry: CleanupCase): VoiceCorrectionRequest {
  const recentContext = entry.recentContext ?? [];
  const recentPrompts = entry.recentPrompts ?? [];
  return {
    rawText: entry.raw,
    ...(recentContext.length > 0 ? { recentContext } : {}),
    ...(recentPrompts.length > 0 ? { recentPrompts } : {}),
    ...(entry.terminalOutput ? { terminalOutput: entry.terminalOutput } : {}),
    reason: "stop",
    startsPrompt: entry.startsPrompt ?? recentContext.length === 0,
    ...(entry.uncertain?.length ? { uncertain: locateUncertain(entry.raw, entry.uncertain) } : {}),
  };
}

/** What became of a request that brought back no reply to land. */
function withoutReply(result: VoiceCorrectionResult): Disposition {
  return result.failed ? "failed" : "skipped";
}

/** What the service did with a passage, read the way a guard landing reads. */
function dispositionOf(result: VoiceCorrectionResult): Disposition {
  if (!result.proposal) return withoutReply(result);
  if (result.rejected) return "rejected";
  return result.action === "replace" ? "applied" : "declined";
}

/**
 * A reply landed under one guard, the way the service lands it. Without a
 * reply the request failed or was skipped, and every guard keeps the raw text.
 */
function landUnder(
  entry: CleanupCase,
  reply: VoiceCorrectionProposal | undefined,
  limits: GuardVariant["limits"],
  noReply: Disposition,
  vocabulary: VoiceCommandVocabulary
): Landing {
  if (!reply) {
    return { disposition: noReply, landed: entry.raw, landedScore: scoreText(entry, entry.raw) };
  }
  const landing = correctionOutcome(entry.raw, reply, {
    vocabulary,
    startsPrompt: requestFor(entry).startsPrompt === true,
    limits,
  });
  const disposition: Disposition = landing.rejected
    ? "rejected"
    : landing.action === "replace"
      ? "applied"
      : "declined";
  return {
    disposition,
    ...(landing.rejected ? { rejectReason: landing.rejected.reason } : {}),
    landed: landing.confirmedText,
    landedScore: scoreText(entry, landing.confirmedText),
  };
}

function landings(
  entry: CleanupCase,
  reply: VoiceCorrectionProposal | undefined,
  guards: readonly string[],
  noReply: Disposition,
  vocabulary: VoiceCommandVocabulary
): Record<string, Landing> {
  return Object.fromEntries(
    guards.map((guard) => [
      guard,
      landUnder(entry, reply, GUARD_VARIANTS[guard]!.limits, noReply, vocabulary),
    ])
  );
}

function proposalText(entry: CleanupCase, reply: Trial["reply"]): string {
  return reply?.action === "replace" && reply.correctedText.trim()
    ? reply.correctedText.trim()
    : entry.raw;
}

function toTrial(
  entry: CleanupCase,
  variant: Variant,
  repeat: number,
  result: VoiceCorrectionResult,
  guards: readonly string[],
  vocabulary: VoiceCommandVocabulary,
  totalMs: number,
  firstTextAt: number | null
): Trial {
  const reply = result.proposal;
  const proposal = proposalText(entry, reply);
  const usage = result.roundTrip?.usage;
  return {
    caseId: entry.id,
    variant: variant.id,
    repeat,
    ...(reply ? { reply } : {}),
    proposal,
    proposalScore: scoreText(entry, proposal),
    landings: landings(entry, reply, guards, withoutReply(result), vocabulary),
    roundTripMs: result.roundTrip ? Math.round(result.roundTrip.ms) : null,
    ...(firstTextAt !== null && result.roundTrip
      ? { firstTextMs: Math.round(firstTextAt - result.roundTrip.sentAt) }
      : {}),
    totalMs: Math.round(totalMs),
    ...(usage ? { usage } : {}),
    costUsd: requestCost(variant.model, usage),
  };
}

interface PredictionProbe {
  model: string;
  endpoint: "responses" | "chat/completions";
  /** The API answered with a success status; nothing else counts as support. */
  accepted: boolean;
  status: number | null;
  /** The error's code, else its type, else what went wrong on the way. */
  code: string | null;
}

const PROBE_TIMEOUT_MS = 15_000;

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
        headers: {
          "Content-Type": "application/json",
          ...buildOpenAIHeaders(apiKey, ROUTING.organizationId, ROUTING.projectId),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      const data = (await response.json().catch(() => ({}))) as {
        error?: { code?: unknown; type?: unknown };
      };
      const code =
        typeof data.error?.code === "string"
          ? data.error.code
          : typeof data.error?.type === "string"
            ? data.error.type
            : null;
      probes.push({ model, endpoint, accepted: response.ok, status: response.status, code });
    } catch (error) {
      const timedOut = error instanceof DOMException && error.name === "TimeoutError";
      probes.push({
        model,
        endpoint,
        accepted: false,
        status: null,
        code: timedOut ? "timeout" : "network_error",
      });
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

function qualityRow(arm: string, quality: QualitySummary): string {
  const { totals } = quality;
  const rate = (value: number, of: number) => (of === 0 ? "–" : pct(value));
  return `| ${arm} | ${pct(quality.agentReadyRate)} | ${rate(quality.repairRate, totals.repairable)} | ${rate(quality.misreadRate, totals.misreads)} | ${rate(quality.formRate, totals.forms)} | ${rate(quality.dropRate, totals.drops)} | ${rate(quality.splitRate, totals.splits)} | ${rate(quality.keepRate, totals.keeps)} | ${pct(quality.referenceMatchRate)} | ${pct(quality.rawWer)} → ${pct(quality.wer)} | ${quality.broken} | ${quality.novelWords} | ${quality.addedWords} | ${quality.trialsWithMeaningRisk} |`;
}

const QUALITY_HEADER = [
  "| Arm | Ready | Repaired | Misreads | Forms | Drops | Splits | Keeps | Matches ref | WER raw → clean | Broken | Novel | Added | Risky trials |",
  "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
];

function latencyCells(latency: LatencySummary): string {
  if (latency.count === 0) return "0 | – | – | – | –";
  return `${latency.count} | ${ms(latency.p50)} | ${ms(latency.p95)} | ${ms(latency.max)} | ${pct(latency.overTarget)}`;
}

interface AdversarialResult {
  guard: string;
  caseId: string;
  harm: string;
  /** The check that refused it; null when it landed. */
  refusedBy: string | null;
}

export interface RunRecord {
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
  stream: boolean;
  variants: Variant[];
  /** The rules each variant sent, whole, so a later reader knows exactly what was asked. */
  prompts: Record<
    string,
    { description: string; instructions: CorrectionInstructions; hash: string }
  >;
  /** Each edit budget the replies were landed under. */
  guards: Record<string, GuardVariant>;
  profile: Profile;
  corpusHash: string;
  /** Each passage as it was sent, so a later rescore can tell whether its input has changed since. */
  corpus: Array<{
    id: string;
    style: TranscriptStyle;
    source: string;
    chars: number;
    inputHash: string;
    sent: VoiceCorrectionRequest;
    /** The worktree and repository names its prompt carried; absent for none. */
    session?: CleanupSession;
  }>;
  /** Passages a rescore left out because the corpus no longer has them, or no longer sends them the same. */
  rescoreExclusions?: Array<{ id: string; reason: "removed" | "input changed"; trials: number }>;
  /**
   * Replies the service landed differently from how the benchmark lands them
   * under production's budget; anything but 0 means the guard replay is wrong.
   */
  parityMisses: number;
  adversarial: AdversarialResult[];
  prices: typeof MODEL_PRICES;
  predictionProbes: PredictionProbe[];
  trials: Trial[];
  summaries: VariantSummary[];
}

function summarise(run: RunRecord, corpus: readonly CleanupCase[]): VariantSummary[] {
  return run.variants.flatMap((variant) =>
    Object.keys(run.guards).map((guard) => summariseVariant(variant.id, guard, run.trials, corpus))
  );
}

// Under the limits the run records, so a rescore that keeps a run's guards
// lands these as it lands the run's replies.
function landAdversarial(
  guards: Readonly<Record<string, GuardVariant>>,
  corpus: readonly CleanupCase[],
  vocabulary: VoiceCommandVocabulary
) {
  const byId = new Map(corpus.map((entry) => [entry.id, entry]));
  return Object.entries(guards).flatMap(([guard, { limits }]) =>
    ADVERSARIAL_PROPOSALS.flatMap(({ caseId, harm, proposal }): AdversarialResult[] => {
      const entry = byId.get(caseId);
      if (!entry) return [];
      const landing = landUnder(
        entry,
        { action: "replace", correctedText: proposal, confidence: "high" },
        limits,
        "skipped",
        vocabulary
      );
      return [{ guard, caseId, harm, refusedBy: landing.rejectReason ?? null }];
    })
  );
}

const armName = (summary: VariantSummary) => `${summary.variant} · ${summary.guard}`;

export function renderReport(run: RunRecord, corpus: readonly CleanupCase[]): string {
  const lines: string[] = [];
  const longCases = corpus.filter((entry) => entry.raw.length >= PROMPT_LENGTH_MIN_CHARS).length;
  const guards = Object.keys(run.guards);
  const firstGuard = guards[0]!;
  const perVariant = run.summaries.filter((summary) => summary.guard === firstGuard);
  lines.push(
    `# Dictation cleanup benchmark: ${run.label}`,
    "",
    `${run.startedAt} · ${run.git.revision.slice(0, 10)}${run.git.dirty ? " (dirty)" : ""} · ${corpus.length} passages (${longCases} of ${PROMPT_LENGTH_MIN_CHARS}+ chars) × ${run.repeats} repeat(s) · seed ${run.seed}${run.complete ? "" : " · **incomplete**"}`,
    "",
    `Prompts: ${Object.entries(run.prompts)
      .map(([name, prompt]) => `\`${name}\` (${prompt.hash.slice(0, 10)}, ${prompt.description})`)
      .join("; ")}.`,
    "",
    `Guards: ${Object.entries(run.guards)
      .map(([name, guard]) => `\`${name}\` (${guard.description})`)
      .join("; ")}.`,
    ""
  );
  if (run.parityMisses > 0) {
    lines.push(
      `**${run.parityMisses} replies landed differently in the service than in the guard replay.** The guard rows can't be trusted until that's fixed.`,
      ""
    );
  }
  if (run.rescoreExclusions) {
    const excluded = run.rescoreExclusions
      .map((exclusion) => `${exclusion.id} (${exclusion.reason}, ${exclusion.trials} trials)`)
      .join(", ");
    lines.push(
      `Rescored with scoring v${run.scoringVersion}${excluded ? `, leaving out ${excluded}` : ""}.`,
      ""
    );
  }
  lines.push(
    "## What landed",
    "",
    "Each reply landed under each guard, model:effort/prompt · guard. Ready: the message the speaker would have typed (an accepted reference's words and lines, every misread and form fix and every drop landed, nothing kept lost, any run-on broken up). Repaired: reference words the raw transcript had wrong that came back right. Misreads: fixes for a word the raw transcript got wrong, one an agent would take for something else, landed exactly; a model or prompt choice rests on these. Forms: fixes that only write the speaker's own words the way they would have typed them, landed exactly; an agent reads those right either way. Drops: filler and retracted words taken out. Splits: run-ons broken into sentences under the passage's cap. Keeps: the case's own, plus every code span, reference, flag, path and number in the raw transcript. Broken: words the raw had right that were lost or changed. Novel: words in neither the raw nor the reference. Added: words inserted beyond any the raw already had extra. Risky trials: any broken, novel or added word, or a keep lost.",
    "",
    ...QUALITY_HEADER,
    ...run.summaries.map((summary) => qualityRow(armName(summary), summary.landed)),
    "",
    "## What the model proposed",
    "",
    "Before any check: every reply scored as if it had landed.",
    "",
    ...QUALITY_HEADER,
    ...perVariant.map((summary) => qualityRow(summary.variant, summary.proposed)),
    "",
    "## Dispositions and guard checks",
    "",
    "Caught: a proposal with a meaning risk that a guard check refused. Let through: one that landed. Held back: a proposal with no meaning risk that a guard check refused, so the raw text stayed (ready: it was the message the speaker would have typed). The confidence and command checks aren't guard checks.",
    "",
    "| Arm | Applied | Declined | Rejected | Failed | Skipped | Reject reasons | Caught | Let through | Held back (ready) | Clean passages untouched |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...run.summaries.map((summary) => {
      const d = summary.dispositions;
      const g = summary.guardChecks;
      const reasons =
        Object.entries(summary.rejectReasons)
          .sort((a, b) => b[1] - a[1])
          .map(([reason, n]) => `${reason} ${n}`)
          .join(", ") || "–";
      return `| ${armName(summary)} | ${d.applied} | ${d.declined} | ${d.rejected} | ${d.failed} | ${d.skipped} | ${reasons} | ${g.caught} | ${g.letThrough} | ${g.heldBack} (${g.heldBackReady}) | ${summary.cleanUntouched.kept}/${summary.cleanUntouched.of} |`;
    }),
    ""
  );
  if (run.adversarial.length > 0) {
    lines.push(
      "## Cleanups that lose meaning, under each guard",
      "",
      "Hand-written cleanups that each do one kind of harm, landed under every guard. Some no word count can see; those land under all of them.",
      "",
      `| Passage | Harm | ${guards.join(" | ")} |`,
      `| --- | --- | ${guards.map(() => "---").join(" | ")} |`
    );
    for (const { caseId, harm } of ADVERSARIAL_PROPOSALS) {
      const cells = guards.map((guard) => {
        const result = run.adversarial.find(
          (entry) => entry.guard === guard && entry.caseId === caseId && entry.harm === harm
        );
        if (!result) return "–";
        return result.refusedBy === null ? "**landed**" : `refused (${result.refusedBy})`;
      });
      lines.push(`| ${caseId} | ${harm} | ${cells.join(" | ")} |`);
    }
    lines.push("");
  }
  lines.push(
    "## Latency (ms)",
    "",
    `Per request, so the same under every guard. Round trip is the service's own, request out to reply read, over the requests that came back readable (n). Total is all of \`correct()\` for every trial, the wait for a preconnect and failures included. Over target: share above ${SEND_WAIT_TARGET_MS} ms.`,
    "",
    "| Variant | n | p50 | p95 | max | over target | prompt-length n | p50 | p95 | max | over target | total n | p50 | p95 | max | over target |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...perVariant.map(
      (summary) =>
        `| ${summary.variant} | ${latencyCells(summary.roundTrip)} | ${latencyCells(summary.promptLengthRoundTrip)} | ${latencyCells(summary.total)} |`
    ),
    "",
    ...(run.stream
      ? [
          "First text: request out to the first corrected text the stream showed, when the composer starts to change.",
          "",
          "| Variant | n | p50 | p95 | max | over target | prompt-length n | p50 | p95 | max | over target |",
          "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
          ...perVariant.map(
            (summary) =>
              `| ${summary.variant} | ${latencyCells(summary.firstText)} | ${latencyCells(summary.promptLengthFirstText)} |`
          ),
          "",
        ]
      : []),
    "## Tokens and cost",
    "",
    "| Variant | Mean input | Cached | Mean output | Mean reasoning | Cache writes | Per cleanup | Run total |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...perVariant.map(
      (summary) =>
        `| ${summary.variant} | ${Math.round(summary.tokens.meanInput)} | ${pct(summary.tokens.cachedShare)} | ${Math.round(summary.tokens.meanOutput)} | ${Math.round(summary.tokens.meanReasoning)} | ${summary.tokens.cacheWrites} | ${usd(summary.meanCostUsd)} | ${usd(summary.totalCostUsd, 3)} |`
    ),
    ""
  );

  const twins = recentPromptTwins(corpus);
  if (twins.length > 0) {
    lines.push(
      "## With and without recent prompts",
      "",
      `Each passage sent with the prompts last sent to its terminal (#14855), beside the same passage sent without them, over the repeats both ran, under the \`${firstGuard}\` guard. Clean kept: passages that should come back untouched and did. Risky: trials with a broken, novel or added word. Cached: the share of input read from the prompt cache. Cache writes bill at 1.25 times the input rate.`,
      "",
      "| Variant | Recent prompts | Trials | Misreads landed | Clean kept | Risky trials | Mean input | Cached | Cache writes | Per cleanup |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"
    );
    const withPrompts = twins.map((twin) => twin.withPrompts);
    const bare = twins.map((twin) => twin.bare);
    for (const variant of run.variants) {
      const ran = new Map(
        run.trials
          .filter((trial) => trial.variant === variant.id)
          .map((trial) => [`${trial.caseId}#${trial.repeat}`, trial])
      );
      const paired: Array<[Trial, Trial]> = twins.flatMap((twin) =>
        run.trials.flatMap((trial) => {
          if (trial.variant !== variant.id || trial.caseId !== twin.withPrompts.id) return [];
          const other = ran.get(`${twin.bare.id}#${trial.repeat}`);
          return other ? [[trial, other] as [Trial, Trial]] : [];
        })
      );
      const sides: Array<[string, Trial[], CleanupCase[]]> = [
        ["with", paired.map(([trial]) => trial), withPrompts],
        ["without", paired.map(([, trial]) => trial), bare],
      ];
      for (const [side, trials, entries] of sides) {
        const summary = summariseVariant(variant.id, firstGuard, trials, entries);
        lines.push(
          `| ${variant.id} | ${side} | ${summary.trials} | ${pct(summary.landed.misreadRate)} | ${summary.cleanUntouched.kept}/${summary.cleanUntouched.of} | ${summary.landed.trialsWithMeaningRisk} | ${Math.round(summary.tokens.meanInput)} | ${pct(summary.tokens.cachedShare)} | ${summary.tokens.cacheWrites} | ${usd(summary.meanCostUsd)} |`
        );
      }
    }
    lines.push("");
  }

  const groups: Array<[string, (entry: CleanupCase) => string]> = [
    ["source", (entry) => entry.source],
    ["style", (entry) => entry.style],
  ];
  const byId = new Map(corpus.map((entry) => [entry.id, entry]));
  for (const [name, key] of groups) {
    const values = [...new Set(corpus.map(key))];
    lines.push(
      `## Ready, misreads and forms landed, by ${name}`,
      "",
      `Under the \`${firstGuard}\` guard, each cell: ready trials / trials · misread fixes landed · form fixes landed.`,
      "",
      `| ${name} | passages | ${run.variants.map((variant) => variant.id).join(" | ")} |`,
      `| --- | --- | ${run.variants.map(() => "---").join(" | ")} |`
    );
    for (const value of values) {
      const cells = run.variants.map((variant) => {
        const rows = run.trials.filter(
          (trial) => trial.variant === variant.id && key(byId.get(trial.caseId)!) === value
        );
        const scoreOf = (trial: Trial) => trial.landings[firstGuard]?.landedScore;
        const landed = (kind: FixKind) => {
          let count = 0;
          let total = 0;
          for (const trial of rows) {
            total += fixesOf(byId.get(trial.caseId)!, kind).length;
            const score = scoreOf(trial);
            count += (kind === "misread" ? score?.misreadsLanded : score?.formsLanded) ?? 0;
          }
          return total ? `${count}/${total}` : "–";
        };
        const ready = rows.filter((trial) => scoreOf(trial)?.agentReady).length;
        return `${ready}/${rows.length} · ${landed("misread")} · ${landed("form")}`;
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
      "| Model | Endpoint | Status | Answer |",
      "| --- | --- | --- | --- |",
      ...run.predictionProbes.map(
        (probe) =>
          `| ${probe.model} | ${probe.endpoint} | ${probe.status ?? "–"} | ${probe.accepted ? "accepted" : (probe.code ?? "refused")} |`
      ),
      ""
    );
  }

  // Every passage some arm didn't land ready on, or where the arms disagree,
  // with each distinct text an arm landed across the repeats: the passages to
  // read by hand, since no word score sees a reversed meaning.
  const arms = run.variants.flatMap((variant) => guards.map((guard) => ({ variant, guard })));
  const notes = (entry: CleanupCase, score: Trial["proposalScore"]) =>
    [
      score.agentReady ? "ready" : "",
      ...FIX_KINDS.map((kind) => {
        const missed = score.missedFixes.filter((fix) => entry.fixes[fix] === kind);
        return missed.length ? `missed ${kind}s ${missed.join(", ")}` : "";
      }),
      score.missedDrops.length ? `left ${score.missedDrops.join(", ")}` : "",
      score.split === false ? `run-on (${score.longestSentence} words)` : "",
      score.lostKeeps.length ? `lost ${score.lostKeeps.join(", ")}` : "",
      score.broken ? `${score.broken} broken` : "",
      score.novelWords ? `${score.novelWords} novel` : "",
      score.addedWords ? `${score.addedWords} added` : "",
    ].filter(Boolean);
  const toRead = corpus.filter((entry) => {
    const rows = run.trials.filter((trial) => trial.caseId === entry.id);
    const texts = new Set(
      rows.flatMap((trial) => guards.map((guard) => trial.landings[guard]?.landed))
    );
    return (
      texts.size > 1 ||
      rows.some((trial) => guards.some((guard) => !trial.landings[guard]?.landedScore.agentReady))
    );
  });
  lines.push(`## Passages to read (${toRead.length})`, "");
  for (const entry of toRead) {
    lines.push(
      `### ${entry.id}`,
      "",
      `- raw: ${JSON.stringify(entry.raw)}`,
      `- reference: ${JSON.stringify(entry.reference)}`
    );
    for (const { variant, guard } of arms) {
      const rows = run.trials.filter(
        (trial) => trial.caseId === entry.id && trial.variant === variant.id
      );
      const seen = new Map<string, { count: number; landing: Landing; proposal: string }>();
      for (const trial of rows) {
        const landing = trial.landings[guard];
        if (!landing) continue;
        const key = `${landing.landed}\u0000${trial.proposal}`;
        const known = seen.get(key);
        if (known) known.count++;
        else seen.set(key, { count: 1, landing, proposal: trial.proposal });
      }
      for (const { count, landing, proposal } of seen.values()) {
        const disposition =
          landing.disposition + (landing.rejectReason ? ` (${landing.rejectReason})` : "");
        const proposed =
          landing.disposition === "rejected"
            ? ` — proposed ${JSON.stringify(proposal)} (${notes(entry, scoreText(entry, proposal)).join("; ")})`
            : "";
        lines.push(
          `- ${variant.id} · ${guard}${count > 1 ? ` ×${count}` : ""}: ${JSON.stringify(landing.landed)} (${[disposition, ...notes(entry, landing.landedScore)].join("; ")})${proposed}`
        );
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}

// A passage with no session hashes as it did before sessions existed, so a
// run from then still rescores.
export function inputHash(entry: CleanupCase): string {
  const sent = requestFor(entry);
  return contentHash(JSON.stringify(entry.session ? { sent, session: entry.session } : sent));
}

// A saved run scored again with today's references and checks. A passage the
// corpus no longer has, or no longer sends exactly as it did, can't be: its
// replies answered a different input. Those are left out and named.
export function rescore(
  file: string,
  guardNames: string[] | null = null,
  today: readonly CleanupCase[] = CLEANUP_CORPUS
): { run: RunRecord; corpus: CleanupCase[] } {
  const run = JSON.parse(readFileSync(file, "utf8")) as RunRecord;
  if (run.schemaVersion !== VOICE_CLEANUP_SCHEMA_VERSION) {
    throw new Error(
      `${file}: schema ${run.schemaVersion}, this script reads ${VOICE_CLEANUP_SCHEMA_VERSION}`
    );
  }
  const current = new Map(today.map((entry) => [entry.id, entry]));
  const corpus: CleanupCase[] = [];
  run.rescoreExclusions = [];
  for (const saved of run.corpus) {
    const entry = current.get(saved.id);
    const reason = !entry
      ? "removed"
      : inputHash(entry) !== saved.inputHash
        ? "input changed"
        : null;
    if (reason) {
      const trials = run.trials.filter((trial) => trial.caseId === saved.id).length;
      run.rescoreExclusions.push({ id: saved.id, reason, trials });
    } else {
      corpus.push(entry!);
    }
  }
  // Reference and check edits keep a passage's input, so they reach a rescore:
  // they must be as sound as they would have to be for a new run.
  const problems = corpusProblems(corpus);
  if (problems.length > 0) {
    throw new Error(`the corpus has problems:\n  ${problems.join("\n  ")}`);
  }
  // Guards named now are today's; otherwise the run's own, as it saved them.
  if (guardNames) {
    run.guards = Object.fromEntries(guardNames.map((name) => [name, GUARD_VARIANTS[name]!]));
  }
  const kept = new Set(corpus.map((entry) => entry.id));
  run.trials = run.trials
    .filter((trial) => kept.has(trial.caseId))
    .map((trial) => {
      const entry = current.get(trial.caseId)!;
      const noReply = Object.values(trial.landings)[0]?.disposition ?? "failed";
      const proposal = proposalText(entry, trial.reply);
      return {
        ...trial,
        proposal,
        proposalScore: scoreText(entry, proposal),
        landings: Object.fromEntries(
          Object.entries(run.guards).map(([name, guard]) => [
            name,
            landUnder(
              entry,
              trial.reply as VoiceCorrectionProposal | undefined,
              guard.limits,
              noReply,
              vocabularyOf(run.profile)
            ),
          ])
        ),
      };
    });
  run.scoringVersion = VOICE_CLEANUP_SCORING_VERSION;
  run.adversarial = landAdversarial(run.guards, corpus, vocabularyOf(run.profile));
  run.summaries = summarise(run, corpus);
  return { run, corpus };
}

async function main(): Promise<number> {
  let options: Options | null;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[voice-cleanup] ${formatErrorMessage(error, "bad arguments")}\n\n${USAGE}`);
    return 1;
  }
  if (!options) {
    console.log(USAGE);
    return 0;
  }

  if (options.rescore) {
    const { run, corpus } = rescore(options.rescore, options.guards);
    for (const excluded of run.rescoreExclusions ?? []) {
      console.error(`[voice-cleanup] left out ${excluded.id}: ${excluded.reason}`);
    }
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

  const profile = profileFor(options);
  const guards = options.guards ?? ["v11", "production"];
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
    stream: options.stream,
    repeats: options.repeats,
    variants: options.variants,
    prompts: Object.fromEntries(
      options.variants.map((variant) => {
        const instructions = instructionsOf(variant);
        return [
          variant.id,
          {
            description: PROMPT_VARIANTS[variant.prompt]!.description,
            instructions,
            hash: contentHash(buildCorrectionSystemPrompt(profile, instructions)),
          },
        ];
      })
    ),
    guards: Object.fromEntries(guards.map((name) => [name, GUARD_VARIANTS[name]!])),
    profile,
    corpusHash: contentHash(JSON.stringify(corpus)),
    corpus: corpus.map((entry) => ({
      id: entry.id,
      style: entry.style,
      source: entry.source,
      chars: entry.raw.length,
      inputHash: inputHash(entry),
      sent: requestFor(entry),
      ...(entry.session ? { session: entry.session } : {}),
    })),
    parityMisses: 0,
    adversarial: [],
    prices: MODEL_PRICES,
    predictionProbes: [],
    trials: [],
    summaries: [],
  };
  run.adversarial = landAdversarial(run.guards, corpus, vocabularyOf(profile));
  // Written whole and renamed into place after every request, so an
  // interrupted run keeps every reply it paid for.
  const save = () => {
    run.summaries = summarise(run, corpus);
    writeFileSync(`${jsonPath}.tmp`, `${JSON.stringify(run, null, 2)}\n`);
    renameSync(`${jsonPath}.tmp`, jsonPath);
  };
  save();
  // The first Ctrl+C lets the request in flight land, since it is already
  // paid for; a second one leaves at once.
  let interrupted = false;
  const stopEarly = () => {
    save();
    console.error(`\n[voice-cleanup] interrupted; kept ${run.trials.length} trials in ${jsonPath}`);
    process.exit(130);
  };
  process.on("SIGINT", () => {
    if (interrupted) stopEarly();
    interrupted = true;
    console.error(
      "\n[voice-cleanup] stopping after the request in flight (Ctrl+C again to quit now)"
    );
  });

  if (options.probePrediction) {
    for (const model of new Set(options.variants.map((variant) => variant.model))) {
      run.predictionProbes.push(...(await probePredictedOutputs(model, apiKey)));
      save();
    }
  }

  const services = new Map<string, VoiceCorrectionServiceType>(
    options.variants.map((variant) => [variant.id, new VoiceCorrectionService()])
  );
  // Production warms the prompt while the user dictates; so does this, once
  // for each session the passages are dictated in.
  for (const variant of options.variants) {
    for (const session of cleanupSessions(corpus)) {
      await services.get(variant.id)!.warm(settingsFor(variant, profile, apiKey, session));
    }
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
        let firstTextAt: number | null = null;
        // Production always streams; the first text is when the composer starts to change.
        const onText = options.stream
          ? () => {
              firstTextAt ??= performance.now();
            }
          : undefined;
        const result = await service.correct(
          requestFor(entry),
          settingsFor(variant, profile, apiKey, entry.session),
          undefined,
          onText
        );
        const totalMs = performance.now() - started;
        run.trials.push(
          toTrial(
            entry,
            variant,
            repeat,
            result,
            guards,
            vocabularyOf(profile),
            totalMs,
            firstTextAt
          )
        );
        // The replay must land a reply exactly as the service just did: the
        // same text, disposition and reason, through the path the guards use.
        const replayed = landUnder(
          entry,
          result.proposal,
          CORRECTION_GUARD_LIMITS,
          withoutReply(result),
          vocabularyOf(profile)
        );
        if (
          replayed.landed !== result.confirmedText ||
          replayed.disposition !== dispositionOf(result) ||
          (replayed.rejectReason ?? null) !== (result.rejected?.reason ?? null)
        ) {
          run.parityMisses++;
          console.error(`[voice-cleanup] ${entry.id}: the guard replay landed it differently`);
        }
        done++;
        save();
        if (interrupted) stopEarly();
      }
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error("[voice-cleanup] fatal:", error);
      process.exit(1);
    }
  );
}
