import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { contentHash } from "../../e2e/helpers/voiceReplayScore";
import {
  buildCorrectionSystemPrompt,
  TRANSCRIBER_NOTES,
  type CorrectionInstructions,
  type VoiceReasoningEffort,
} from "../../shared/config/voiceCorrection";
import { formatErrorMessage } from "../../shared/utils/errorMessage";
import { buildOpenAIHeaders } from "../../shared/utils/openaiHeaders";
import { getAgentConfig } from "../../shared/config/agentRegistry";
import { getBuiltinSlashCommands, type SlashCommand } from "../../shared/types/slashCommands";
import { buildVoiceCommandVocabulary } from "../../shared/utils/voiceAgentCommands";
import type { VoiceAgentReply } from "../../electron/services/voiceAgentReplyTypes";
import type { VoiceCommandTarget } from "../../electron/services/voiceCommandTarget";
import type {
  VoiceCorrectionRequest,
  VoiceCorrectionResult,
  VoiceCorrectionService as VoiceCorrectionServiceType,
  VoiceCorrectionSettings,
} from "../../electron/services/VoiceCorrectionService";
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
  type CleanupCommandTarget,
  type CleanupSession,
  type CorpusAgentReply,
  type FixKind,
  type TranscriptStyle,
} from "./lib/voiceCleanupCorpus";
import { PROMPT_VARIANTS } from "./lib/voiceCleanupPrompts";
import {
  codeNamesOf,
  corpusProblems,
  fixesOf,
  locatePauses,
  locateUncertain,
  MODEL_PRICES,
  PROMPT_LENGTH_MIN_CHARS,
  requestCost,
  scoreText,
  SEND_WAIT_TARGET_MS,
  seededShuffle,
  summariseVariant,
  VOICE_CLEANUP_READABLE_SCHEMAS,
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
  --repeats <n>         passes over the corpus (default 1)
  --cases <list>        only cases whose id starts with one of these
  --styles <list>       only these transcript styles (${STYLES.join(", ")})
  --dictionary <list>   custom dictionary terms, the same for every variant (default none)
  --seed <n>            request order seed (default 14793)
  --label <name>        result file prefix (default run)
  --no-stream           ask for the whole reply at once, as cleanup did before it streamed
  --no-transcriber      leave out the notes on the transcriber a passage imitates, which
                        production sends rules that name them
  --probe-prediction    also ask each model for Predicted Outputs and record the answer
  --rescore <run.json>  score a saved run again with today's corpus and scoring, sending
                        nothing, landing its replies as production lands them now`;

interface Variant {
  /** `model:effort/prompt`. */
  id: string;
  model: string;
  effort: VoiceReasoningEffort;
  prompt: string;
}

interface Options {
  variants: Variant[];
  repeats: number;
  cases: string[];
  styles: TranscriptStyle[];
  dictionary: string[];
  seed: number;
  label: string;
  probePrediction: boolean;
  stream: boolean;
  transcriber: boolean;
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
    repeats: 1,
    cases: [],
    styles: [...STYLES],
    dictionary: [],
    seed: 14793,
    label: "run",
    probePrediction: false,
    stream: true,
    transcriber: true,
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
      case "--no-transcriber":
        options.transcriber = false;
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

/**
 * The agent with its built-in commands and the ones installed beside them, as
 * production describes a terminal running it; with none installed, Claude
 * Code is every passage's target but those whose session names another.
 */
function agentCommandTarget({ agentId, installed }: CleanupCommandTarget): VoiceCommandTarget {
  const config = getAgentConfig(agentId)!;
  const commands: SlashCommand[] = installed.map(({ token, description }) => ({
    id: `user:${token}`,
    label: token,
    insertText: token,
    description,
    scope: "user",
    agentId,
    kind: "skill",
    trigger: token.startsWith("$") ? "$" : "/",
  }));
  return {
    agentId,
    agentName: config.name,
    isAssistant: false,
    vocabulary: buildVoiceCommandVocabulary(
      [...commands, ...getBuiltinSlashCommands(agentId)],
      config.completionSources ?? []
    ),
  };
}

function claudeCodeTarget(): VoiceCommandTarget {
  return agentCommandTarget({ agentId: "claude", installed: [] });
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
  session: CleanupSession | undefined,
  // The provider whose error style the passage imitates, told as production tells the one in use.
  style?: TranscriptStyle
): VoiceCorrectionSettings {
  const { commandTarget, ...names } = session ?? {};
  return {
    ...profile,
    ...names,
    ...(style && style !== "generic" ? { transcriber: style } : {}),
    ...(commandTarget ? { commandTarget: agentCommandTarget(commandTarget) } : {}),
    model: variant.model,
    reasoningEffort: variant.effort,
    instructions: instructionsOf(variant),
    apiKey,
    ...ROUTING,
  };
}

// The reply's times, stamped as long before `now` as the corpus says.
export function agentReplyAt(reply: CorpusAgentReply, now: number): VoiceAgentReply {
  const before = (minutes: number | null) => (minutes === null ? null : now - minutes * 60_000);
  const { observedState } = reply;
  return {
    text: reply.text,
    truncated: reply.truncated === true,
    recordedAt: before(reply.recordedMinutesAgo),
    newerRecordsFollow: reply.newerRecordsFollow,
    ...(observedState
      ? {
          observedState: {
            state: observedState.state,
            ...(observedState.waitingReason ? { waitingReason: observedState.waitingReason } : {}),
            lastStateChangeAt: before(observedState.changedMinutesAgo),
          },
        }
      : {}),
  };
}

// Stamps a reply's times from a fixed clock, so a passage hashes the same
// whenever a run sent it.
const HASH_CLOCK = 0;

// Code names go to every variant; the service drops them for rules that
// don't say what they are, as it does in production.
export function requestFor(entry: CleanupCase, now: number = Date.now()): VoiceCorrectionRequest {
  const recentContext = entry.recentContext ?? [];
  const recentPrompts = entry.recentPrompts ?? [];
  const codeNames = codeNamesOf(entry);
  return {
    rawText: entry.raw,
    ...(recentContext.length > 0 ? { recentContext } : {}),
    ...(entry.followingText ? { followingText: entry.followingText } : {}),
    ...(recentPrompts.length > 0 ? { recentPrompts } : {}),
    ...(entry.terminalOutput ? { terminalOutput: entry.terminalOutput } : {}),
    ...(codeNames.length > 0 ? { codeNames } : {}),
    ...(entry.agentReply ? { agentReply: agentReplyAt(entry.agentReply, now) } : {}),
    reason: "stop",
    startsPrompt: entry.startsPrompt ?? recentContext.length === 0,
    ...(entry.uncertain?.length ? { uncertain: locateUncertain(entry.raw, entry.uncertain) } : {}),
    ...(entry.pauses?.length ? { pauses: locatePauses(entry.raw, entry.pauses) } : {}),
  };
}

/** What became of a request that brought back no reply to land. */
function withoutReply(result: VoiceCorrectionResult): Disposition {
  return result.failed ? "failed" : "skipped";
}

/** What the service did with a passage, read the way `land` reads a landing. */
function dispositionOf(result: VoiceCorrectionResult): Disposition {
  if (!result.proposal) return withoutReply(result);
  return result.action === "replace" ? "applied" : "declined";
}

/**
 * A reply landed the way the service lands it, through production's own
 * `correctionOutcome`. Without a reply the request failed or was skipped, and
 * the raw text stands.
 */
function land(
  entry: CleanupCase,
  reply: VoiceCorrectionProposal | undefined,
  noReply: Disposition
): Landing {
  if (!reply) {
    return { disposition: noReply, landed: entry.raw, landedScore: scoreText(entry, entry.raw) };
  }
  const landing = correctionOutcome(entry.raw, reply);
  return {
    disposition: landing.action === "replace" ? "applied" : "declined",
    landed: landing.confirmedText,
    landedScore: scoreText(entry, landing.confirmedText),
  };
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
    landing: land(entry, reply, withoutReply(result)),
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

function qualityRow(variant: string, quality: QualitySummary): string {
  const { totals } = quality;
  const rate = (value: number, of: number) => (of === 0 ? "–" : pct(value));
  return `| ${variant} | ${pct(quality.agentReadyRate)} | ${rate(quality.repairRate, totals.repairable)} | ${rate(quality.misreadRate, totals.misreads)} | ${rate(quality.formRate, totals.forms)} | ${rate(quality.dropRate, totals.drops)} | ${rate(quality.splitRate, totals.splits)} | ${rate(quality.keepRate, totals.keeps)} | ${pct(quality.referenceMatchRate)} | ${pct(quality.rawWer)} → ${pct(quality.wer)} | ${quality.broken} | ${quality.novelWords} | ${quality.addedWords} | ${quality.trialsWithMeaningRisk} |`;
}

const QUALITY_HEADER = [
  "| Variant | Ready | Repaired | Misreads | Forms | Drops | Splits | Keeps | Matches ref | WER raw → clean | Broken | Novel | Added | Risky trials |",
  "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
];

function latencyCells(latency: LatencySummary): string {
  if (latency.count === 0) return "0 | – | – | – | –";
  return `${latency.count} | ${ms(latency.p50)} | ${ms(latency.p95)} | ${ms(latency.max)} | ${pct(latency.overTarget)}`;
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
  /** Absent in runs saved before cleanup was told the transcriber; those sent no notes. */
  transcriber?: boolean;
  /** The notes sent to rules that name them, by the style a passage imitates. */
  transcriberNotes?: typeof TRANSCRIBER_NOTES;
  variants: Variant[];
  /** The rules each variant sent, whole, so a later reader knows exactly what was asked. */
  prompts: Record<
    string,
    { description: string; instructions: CorrectionInstructions; hash: string }
  >;
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
   * with production's checks; anything but 0 means the landed scores, and any
   * rescore, land replies the service wouldn't have.
   */
  parityMisses: number;
  prices: typeof MODEL_PRICES;
  predictionProbes: PredictionProbe[];
  trials: Trial[];
  summaries: VariantSummary[];
}

function summarise(run: RunRecord, corpus: readonly CleanupCase[]): VariantSummary[] {
  return run.variants.map((variant) => summariseVariant(variant.id, run.trials, corpus));
}

export function renderReport(run: RunRecord, corpus: readonly CleanupCase[]): string {
  const lines: string[] = [];
  const longCases = corpus.filter((entry) => entry.raw.length >= PROMPT_LENGTH_MIN_CHARS).length;
  lines.push(
    `# Dictation cleanup benchmark: ${run.label}`,
    "",
    `${run.startedAt} · ${run.git.revision.slice(0, 10)}${run.git.dirty ? " (dirty)" : ""} · ${corpus.length} passages (${longCases} of ${PROMPT_LENGTH_MIN_CHARS}+ chars) × ${run.repeats} repeat(s) · seed ${run.seed}${run.complete ? "" : " · **incomplete**"}`,
    "",
    `Prompts: ${Object.entries(run.prompts)
      .map(([name, prompt]) => `\`${name}\` (${prompt.hash.slice(0, 10)}, ${prompt.description})`)
      .join("; ")}.`,
    ""
  );
  if (run.parityMisses > 0) {
    lines.push(
      `**${run.parityMisses} replies landed differently in the service than in the benchmark's replay of its checks.** The landed rows can't be trusted until that's fixed.`,
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
    "Each reply landed as production lands it, exactly as the model wrote it, per model:effort/prompt. Ready: the message the speaker would have typed (an accepted reference's words and lines, every misread and form fix and every drop landed, nothing kept lost, any run-on broken up, every sentence break and unbroken span the passage names where it says). Repaired: reference words the raw transcript had wrong that came back right. Misreads: fixes for a word the raw transcript got wrong, one an agent would take for something else, landed exactly; a model or prompt choice rests on these. Forms: fixes that only write the speaker's own words the way they would have typed them, landed exactly; an agent reads those right either way. Drops: filler and retracted words taken out. Splits: run-ons broken into sentences under the passage's cap. Keeps: the case's own, plus every code span, reference, flag, path and number in the raw transcript. Broken: words the raw had right that were lost or changed. Novel: words in neither the raw nor the reference. Added: words inserted beyond any the raw already had extra. Risky trials: any broken, novel or added word, or a keep lost.",
    "",
    ...QUALITY_HEADER,
    ...run.summaries.map((summary) => qualityRow(summary.variant, summary.landed)),
    "",
    "## What the model proposed",
    "",
    "Every reply as the model proposed it, scored as if it had landed: what landed, unless the run was saved while the agent-command and low-confidence checks stood.",
    "",
    ...QUALITY_HEADER,
    ...run.summaries.map((summary) => qualityRow(summary.variant, summary.proposed)),
    "",
    "## Dispositions",
    "",
    "| Variant | Applied | Declined | Failed | Skipped | Clean passages untouched |",
    "| --- | --- | --- | --- | --- | --- |",
    ...run.summaries.map((summary) => {
      const d = summary.dispositions;
      return `| ${summary.variant} | ${d.applied} | ${d.declined} | ${d.failed} | ${d.skipped} | ${summary.cleanUntouched.kept}/${summary.cleanUntouched.of} |`;
    }),
    "",
    "## Latency (ms)",
    "",
    `Round trip is the service's own, request out to reply read, over the requests that came back readable (n). Total is all of \`correct()\` for every trial, the wait for a preconnect and failures included. Over target: share above ${SEND_WAIT_TARGET_MS} ms.`,
    "",
    "| Variant | n | p50 | p95 | max | over target | prompt-length n | p50 | p95 | max | over target | total n | p50 | p95 | max | over target |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...run.summaries.map(
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
          ...run.summaries.map(
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
    ...run.summaries.map(
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
      "Each passage sent with the prompts last sent to its terminal (#14855), beside the same passage sent without them, over the repeats both ran. Clean kept: passages that should come back untouched and did. Risky: trials with a broken, novel or added word, or a keep lost. Cached: the share of input read from the prompt cache. Cache writes bill at 1.25 times the input rate.",
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
        const summary = summariseVariant(variant.id, trials, entries);
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
      "Each cell: ready trials / trials · misread fixes landed · form fixes landed.",
      "",
      `| ${name} | passages | ${run.variants.map((variant) => variant.id).join(" | ")} |`,
      `| --- | --- | ${run.variants.map(() => "---").join(" | ")} |`
    );
    for (const value of values) {
      const cells = run.variants.map((variant) => {
        const rows = run.trials.filter(
          (trial) => trial.variant === variant.id && key(byId.get(trial.caseId)!) === value
        );
        const landed = (kind: FixKind) => {
          let count = 0;
          let total = 0;
          for (const trial of rows) {
            total += fixesOf(byId.get(trial.caseId)!, kind).length;
            const score = trial.landing.landedScore;
            count += kind === "misread" ? score.misreadsLanded : score.formsLanded;
          }
          return total ? `${count}/${total}` : "–";
        };
        const ready = rows.filter((trial) => trial.landing.landedScore.agentReady).length;
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

  // Every passage some variant didn't land ready on, or where the landed texts
  // differ, with each distinct text a variant landed across the repeats: the
  // passages to read by hand, since no word score sees a reversed meaning.
  const notes = (entry: CleanupCase, score: Trial["proposalScore"]) =>
    [
      score.agentReady ? "ready" : "",
      ...FIX_KINDS.map((kind) => {
        const missed = score.missedFixes.filter((fix) => entry.fixes[fix] === kind);
        return missed.length ? `missed ${kind}s ${missed.join(", ")}` : "";
      }),
      score.missedDrops.length ? `left ${score.missedDrops.join(", ")}` : "",
      score.split === false ? `run-on (${score.longestSentence} words)` : "",
      score.missedBreaks.length ? `no break after ${score.missedBreaks.join(", ")}` : "",
      score.splitSpans.length ? `split ${score.splitSpans.join(", ")}` : "",
      score.lostKeeps.length ? `lost ${score.lostKeeps.join(", ")}` : "",
      score.broken ? `${score.broken} broken` : "",
      score.novelWords ? `${score.novelWords} novel` : "",
      score.addedWords ? `${score.addedWords} added` : "",
    ].filter(Boolean);
  const toRead = corpus.filter((entry) => {
    const rows = run.trials.filter((trial) => trial.caseId === entry.id);
    const texts = new Set(rows.map((trial) => trial.landing.landed));
    return texts.size > 1 || rows.some((trial) => !trial.landing.landedScore.agentReady);
  });
  lines.push(`## Passages to read (${toRead.length})`, "");
  for (const entry of toRead) {
    lines.push(
      `### ${entry.id}`,
      "",
      `- raw: ${JSON.stringify(entry.raw)}`,
      ...(entry.pauses?.length
        ? [`- pauses after: ${entry.pauses.map((phrase) => JSON.stringify(phrase)).join(", ")}`]
        : []),
      `- reference: ${JSON.stringify(entry.reference)}`
    );
    for (const variant of run.variants) {
      const rows = run.trials.filter(
        (trial) => trial.caseId === entry.id && trial.variant === variant.id
      );
      const seen = new Map<string, { count: number; landing: Landing }>();
      for (const trial of rows) {
        const { landing } = trial;
        // A declined reply and a failed request both land the raw text; each keeps its own row.
        const key = `${landing.landed}\u0000${landing.disposition}`;
        const known = seen.get(key);
        if (known) known.count++;
        else seen.set(key, { count: 1, landing });
      }
      for (const { count, landing } of seen.values()) {
        lines.push(
          `- ${variant.id}${count > 1 ? ` ×${count}` : ""}: ${JSON.stringify(landing.landed)} (${[landing.disposition, ...notes(entry, landing.landedScore)].join("; ")})`
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
  const sent = requestFor(entry, HASH_CLOCK);
  return contentHash(JSON.stringify(entry.session ? { sent, session: entry.session } : sent));
}

/**
 * A run as it was saved. Schema 3 held each reply landed under every guard the
 * run named, beside those guards and the hand-written cleanups they refused; a
 * rescore keeps none of that and lands each reply once.
 */
type SavedTrial = Omit<Trial, "landing"> & {
  landing?: Landing;
  landings?: Record<string, Landing>;
};
type SavedRun = Omit<RunRecord, "trials"> & {
  trials: SavedTrial[];
  guards?: unknown;
  adversarial?: unknown;
};

// A saved run scored again with today's references and checks, its replies
// landed as production lands them now. A passage the corpus no longer has, or
// no longer sends exactly as it did, can't be: its replies answered a
// different input. Those are left out and named.
export function rescore(
  file: string,
  today: readonly CleanupCase[] = CLEANUP_CORPUS
): { run: RunRecord; corpus: CleanupCase[] } {
  const {
    guards: _guards,
    adversarial: _adversarial,
    ...saved
  } = JSON.parse(readFileSync(file, "utf8")) as SavedRun;
  if (!VOICE_CLEANUP_READABLE_SCHEMAS.includes(saved.schemaVersion)) {
    throw new Error(
      `${file}: schema ${saved.schemaVersion}, this script reads ${VOICE_CLEANUP_READABLE_SCHEMAS.join(" and ")}`
    );
  }
  const current = new Map(today.map((entry) => [entry.id, entry]));
  const corpus: CleanupCase[] = [];
  const rescoreExclusions: NonNullable<RunRecord["rescoreExclusions"]> = [];
  for (const passage of saved.corpus) {
    const entry = current.get(passage.id);
    const reason = !entry
      ? "removed"
      : inputHash(entry) !== passage.inputHash
        ? "input changed"
        : null;
    if (reason) {
      const trials = saved.trials.filter((trial) => trial.caseId === passage.id).length;
      rescoreExclusions.push({ id: passage.id, reason, trials });
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
  const kept = new Set(corpus.map((entry) => entry.id));
  const trials = saved.trials
    .filter((trial) => kept.has(trial.caseId))
    .map(({ landings, ...trial }): Trial => {
      const entry = current.get(trial.caseId)!;
      // All a saved landing still says is whether a request with no reply
      // failed or was skipped; every reply lands again.
      const recorded = trial.landing ?? Object.values(landings ?? {})[0];
      const proposal = proposalText(entry, trial.reply);
      return {
        ...trial,
        proposal,
        proposalScore: scoreText(entry, proposal),
        landing: land(
          entry,
          trial.reply as VoiceCorrectionProposal | undefined,
          // A run saved under the old checks may say "rejected"; with no reply, nothing was.
          recorded?.disposition === "skipped" ? "skipped" : "failed"
        ),
      };
    });
  const run: RunRecord = {
    ...saved,
    schemaVersion: VOICE_CLEANUP_SCHEMA_VERSION,
    scoringVersion: VOICE_CLEANUP_SCORING_VERSION,
    rescoreExclusions,
    trials,
    summaries: [],
  };
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
    const { run, corpus } = rescore(options.rescore);
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
    transcriber: options.transcriber,
    ...(options.transcriber ? { transcriberNotes: TRANSCRIBER_NOTES } : {}),
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
            // The notes ride with the rules that name them, so they are part of what was asked.
            hash: contentHash(
              buildCorrectionSystemPrompt(profile, instructions) +
                (options.transcriber && instructions.core.includes("TRANSCRIBER")
                  ? JSON.stringify(TRANSCRIBER_NOTES)
                  : "")
            ),
          },
        ];
      })
    ),
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
    prices: MODEL_PRICES,
    predictionProbes: [],
    trials: [],
    summaries: [],
  };
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
  const warmStyles = options.transcriber
    ? [...new Set(corpus.map((entry) => entry.style))]
    : [undefined];
  for (const variant of options.variants) {
    for (const session of cleanupSessions(corpus)) {
      for (const style of warmStyles) {
        await services.get(variant.id)!.warm(settingsFor(variant, profile, apiKey, session, style));
      }
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
          settingsFor(
            variant,
            profile,
            apiKey,
            entry.session,
            options.transcriber ? entry.style : undefined
          ),
          undefined,
          onText
        );
        const totalMs = performance.now() - started;
        const trial = toTrial(entry, variant, repeat, result, totalMs, firstTextAt);
        run.trials.push(trial);
        // The trial lands the reply as a rescore will, which must be exactly
        // what the service just landed: the same text and disposition.
        const { landing } = trial;
        if (
          landing.landed !== result.confirmedText ||
          landing.disposition !== dispositionOf(result)
        ) {
          run.parityMisses++;
          console.error(`[voice-cleanup] ${entry.id}: the replay landed it differently`);
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
