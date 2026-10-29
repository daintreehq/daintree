import {
  alignWords,
  normaliseWords,
  scoreClip,
  type ClipScore,
} from "../../../e2e/helpers/voiceReplayScore";
import type { GrokTranscriptionTuning } from "../../../electron/services/voice/grokTranscriptionTuning";
import {
  trailingDictationCommands,
  trailingSendCommand,
} from "../../../electron/services/voiceDictationCommands";
import { mayReferenceFile } from "../../../shared/utils/voiceFileLinkCommands";
import { stripHesitations } from "../../../shared/utils/voiceHesitations";
import { percentile, requestCost, type TokenUsage } from "./voiceCleanupScore";

/**
 * Scoring for `npm run perf voice-pipeline`: Grok transcribing a clip as it
 * is spoken, then cleanup over what landed, both against the live services.
 * A session is one dictation, scored for what reached the draft and for how
 * long the speaker waited for it after pressing stop.
 */

export const VOICE_PIPELINE_SCHEMA_VERSION = 1;
// Bumped whenever a score below changes meaning, so a rescore says so.
export const VOICE_PIPELINE_SCORING_VERSION = 3;

/**
 * One way of running the pipeline. Tokens joined with `+`: `prod` (as
 * production runs today), `ep<ms>` (Grok endpointing), `nofmt` (Grok's
 * formatting off, so cleanup writes the words), `spec` (cleanup
 * starts at each utterance end and is kept at the stop when nothing was said
 * since), `raw` (no cleanup).
 */
export interface PipelineArm {
  id: string;
  tuning: Partial<GrokTranscriptionTuning>;
  speculate: boolean;
  cleanup: boolean;
}

export function parsePipelineArm(spec: string): PipelineArm {
  const arm: PipelineArm = { id: spec, tuning: {}, speculate: false, cleanup: true };
  for (const token of spec.split("+")) {
    const endpointing = /^ep(\d+)$/.exec(token);
    if (token === "prod") continue;
    if (token === "spec") arm.speculate = true;
    else if (token === "nofmt") arm.tuning.format = false;
    else if (token === "raw") arm.cleanup = false;
    else if (endpointing) arm.tuning.endpointingMs = Number(endpointing[1]);
    else throw new Error(`unknown arm token "${token}" in "${spec}"`);
  }
  if (arm.speculate && !arm.cleanup) throw new Error(`"${spec}" speculates with no cleanup`);
  return arm;
}

/** A provider event, timed from the session's start. Text stays in the run file only. */
export type PipelineEvent =
  | { at: number; type: "delta"; itemId: string | null; text: string }
  | {
      at: number;
      type: "complete";
      itemId: string | null;
      text: string;
      endOfSpeech: boolean;
      incomplete: boolean;
    }
  | { at: number; type: "error"; code: string; severity: string }
  | { at: number; type: "status"; status: string }
  | { at: number; type: "speech_started" };

export type SpeculationFate =
  /** Started at an utterance end and still matched the transcript at the stop. */
  | "adopted"
  /** Words landed after the last one started, so the stop sent its own. */
  | "missed"
  | "none";

export interface CleanupRecord {
  /** Times from the session's start; null where it never got there. */
  sentAt: number | null;
  firstTextAt: number | null;
  doneAt: number;
  verdict: string;
  /** What the draft holds once the cleanup lands. */
  text: string;
  /** The model's reply before any check, kept with the record; absent when none parsed. */
  proposal?: { action: string; correctedText: string; confidence: string };
  failed: boolean;
  speculation: SpeculationFate;
  /** Every cleanup request the session sent, discarded speculations included. */
  requests: number;
  /** Billed tokens over every request that reported them. */
  usage: TokenUsage[];
  /** Requests that went out but reported no usage, such as a cancelled prefetch. */
  usageMissing?: number;
}

export interface PipelineSession {
  clip: string;
  voice: string;
  arm: string;
  pass: number;
  startError: string | null;
  events: PipelineEvent[];
  audioMs: number;
  /** Silence played after the speech before the stop, as a speaker reaching for the key. */
  stopTailMs: number;
  stopMs: number;
  drainEndMs: number;
  /** How late the latest chunk went out against the capture clock; a stall bursts audio. */
  maxChunkLateMs?: number;
  /** The completions joined as the draft holds them. */
  raw: string;
  cleanup: CleanupRecord | null;
  reconnects: number;
  droppedConnect: number;
}

export interface FormScore {
  words: number;
  edits: number;
  exact: boolean;
}

export interface ScoredPipelineSession {
  session: PipelineSession;
  rawScore: ClipScore;
  /** What the draft holds at the end: the cleanup's text, or the raw text without one. */
  finalScore: ClipScore;
  rawExact: boolean;
  finalExact: boolean;
  /** The words as written, against the reference as written. */
  rawForm: FormScore;
  finalForm: FormScore;
  /** Clip terms present verbatim, as the agent would read them. */
  rawLiteralTerms: number;
  finalLiteralTerms: number;
  termsTotal: number;
  /** False when a request went out without reporting usage, so `cost` is a floor. */
  costComplete: boolean;
  /** Reference words the raw transcript had right that the final text lost. */
  brokenWords: number;
  /** The cleanup's verdict, `none` without one. */
  verdict: string;
  /** Share of the final transcript's words on screen, as preview or text, when stop was pressed. */
  shownAtStop: number | null;
  /** How the text at the stop compares with the final, for a cleanup started at the stop. */
  stopPreview: StopPreviewFate;
  errored: boolean;
  firstDeltaMs: number | null;
  firstFinalMs: number | null;
  stopToLastFinalMs: number | null;
  stopToDrainMs: number;
  /**
   * Stop to the first cleaned words shown that stay; null without any. A reply
   * a check turns down streamed only as a tentative rewrite that went, so it
   * has none.
   */
  stopToFirstCleanMs: number | null;
  /** Stop to the draft holding its final text: the speaker's wait. */
  stopToSettledMs: number;
  cost: number | null;
}

function sameWords(a: string, b: string): boolean {
  const left = normaliseWords(a);
  const right = normaliseWords(b);
  return left.length === right.length && left.every((word, i) => word === right[i]);
}

const FORM_OPEN_RE = /^[`'"\u201c\u2018([]+/u;
const FORM_CLOSE_RE = /[`'"\u201d\u2019)\].,;:!?\u2026]+$/u;
// A plain word: letters, lower case after the first. Its case is free, since a
// sentence's capital is no mistake; an identifier's (useShallow, TS2345) isn't.
const PLAIN_WORD_RE = /^\p{L}[\p{Ll}'\u2019-]*$/u;

/**
 * The words as written: split on whitespace, the punctuation at their edges
 * dropped, plain words in any case. Unlike `normaliseWords` it keeps symbols
 * and joins, so "dash-watch" isn't `--watch` and "use shallow" isn't
 * `useShallow`: what an agent reads, not what the recogniser heard.
 */
export function formWords(text: string): string[] {
  return text
    .split(/\s+/u)
    .map((token) => token.replace(FORM_OPEN_RE, "").replace(FORM_CLOSE_RE, ""))
    .filter(Boolean)
    .map((token) => (PLAIN_WORD_RE.test(token) ? token.toLowerCase() : token));
}

function formScore(reference: string, text: string): FormScore {
  const ref = formWords(reference);
  const alignment = alignWords(ref, formWords(text));
  const edits = alignment.substitutions + alignment.deletions + alignment.insertions;
  return { words: ref.length, edits, exact: edits === 0 };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whether `term` appears in `text` exactly as written, not inside a longer
 * identifier, flag or hyphenated word: `useShallow_extra` and `---watch`
 * don't hold `useShallow` and `--watch`.
 */
export function literalTerm(term: string, text: string): boolean {
  return new RegExp(`(?<![\\p{L}\\p{N}_-])${escapeRegExp(term)}(?!-?[\\p{L}\\p{N}_])`, "u").test(
    text
  );
}

/** Reference words the raw transcript matched that `final` no longer does. */
export function brokenWords(reference: string, raw: string, final: string): number {
  const ref = normaliseWords(reference);
  const before = alignWords(ref, normaliseWords(raw)).referenceOps;
  const after = alignWords(ref, normaliseWords(final)).referenceOps;
  return before.filter((op, i) => op === "match" && after[i] !== "match").length;
}

/**
 * How much of the final transcript the speaker could see as they pressed
 * stop: the completions so far and the preview showing, against everything
 * that landed. A preview that lags shows less.
 */
export function shownAtStop(session: PipelineSession): number | null {
  const total = normaliseWords(session.raw).length;
  if (total === 0) return null;
  const before = session.events.filter((event) => event.at <= session.stopMs);
  const completed = before
    .filter(
      (event): event is Extract<PipelineEvent, { type: "complete" }> => event.type === "complete"
    )
    .map((event) => event.text)
    .join(" ");
  const done = new Set(
    before.flatMap((event) => (event.type === "complete" && event.itemId ? [event.itemId] : []))
  );
  const previews = before.filter(
    (event): event is Extract<PipelineEvent, { type: "delta" }> =>
      event.type === "delta" && (event.itemId === null || !done.has(event.itemId))
  );
  const preview = previews[previews.length - 1];
  const shown = normaliseWords(`${completed} ${preview?.text ?? ""}`).length;
  return Math.min(1, shown / total);
}

/**
 * How the text the provider held at the stop compares with the text the final
 * commits, for a cleanup started at the stop and kept only when the stop's own
 * request would be the same (#15076).
 */
export type StopPreviewFate =
  /** Nothing was pending at the stop: the draft already held its final text, the prefetch's case. */
  | "settled"
  /** The final ends in a spoken command, which production rewrites once it lands. */
  | "command"
  /** The final names a file, which production swaps for a reference once it lands. */
  | "file"
  | "match"
  | "mismatch";

// Each completion as production lands it before cleanup reads it: trimmed,
// its hesitations gone (voiceInput's forwardEvent, for English), joined to
// the last as the draft joins them.
function landedText(pieces: readonly string[]): string {
  return pieces
    .map((piece) => stripHesitations(piece.trim()).trim())
    .filter(Boolean)
    .join(" ");
}

export function stopPreviewFate(session: PipelineSession): StopPreviewFate {
  const completed: string[] = [];
  const done = new Set<string>();
  // Each open item's latest preview, in the order the items opened.
  const previews = new Map<string | null, string>();
  for (const event of session.events) {
    if (event.at > session.stopMs) break;
    if (event.type === "complete") {
      completed.push(event.text);
      if (event.itemId) {
        done.add(event.itemId);
        previews.delete(event.itemId);
      }
    } else if (event.type === "delta" && !(event.itemId && done.has(event.itemId))) {
      previews.set(event.itemId, event.text);
    }
  }
  const after = session.events.filter(
    (event): event is Extract<PipelineEvent, { type: "complete" }> =>
      event.type === "complete" && event.at > session.stopMs && event.text.trim() !== ""
  );
  const pending = [...previews.values()].filter((text) => text.trim() !== "");
  if (pending.length === 0 && after.length === 0) return "settled";
  const final = landedText(
    session.events.flatMap((event) => (event.type === "complete" ? [event.text] : []))
  );
  if (trailingSendCommand(final) || trailingDictationCommands(final)) return "command";
  if (mayReferenceFile(final)) return "file";
  return landedText([...completed, ...pending]) === final ? "match" : "mismatch";
}

/**
 * Other ways of writing a clip's reference that are just as right, kept to two
 * kinds so the scores can't be argued up: spellings the audio can't tell apart,
 * and the layout cleanup's own prompt asks for, a counted list as a numbered
 * one. A session is scored against whichever its text is closest to.
 */
export const ACCEPTED_REFERENCES: Readonly<Record<string, readonly string[]>> = {
  "three-steps": [
    "1. Read the failing test.\n2. Find the race.\n3. Fix it without adding a timeout.",
  ],
  "tailwind-token": [
    "Swap the hard-coded hex color for the text-secondary token from Tailwind and check it in dark mode.",
  ],
};

function closest<T extends { edits: number }>(scores: readonly T[]): T {
  return scores.reduce((best, score) => (score.edits < best.edits ? score : best));
}

function clipEdits(score: ClipScore): number {
  return score.substitutions + score.deletions + score.insertions;
}

export function scorePipelineSession(
  session: PipelineSession,
  references: string | readonly string[],
  terms: readonly string[],
  model: string
): ScoredPipelineSession {
  const accepted = typeof references === "string" ? [references] : references;
  const bestClip = (text: string) =>
    closest(
      accepted.map((ref) => {
        const score = scoreClip(ref, text, terms);
        return { score, edits: clipEdits(score) };
      })
    ).score;
  const bestForm = (text: string) => closest(accepted.map((ref) => formScore(ref, text)));
  // The reference the final text is closest to, so moving between two
  // accepted forms never counts as losing words.
  const finalReference =
    accepted[
      accepted
        .map((ref) => formScore(ref, session.cleanup?.text ?? session.raw).edits)
        .reduce((best, edits, i, all) => (edits < all[best]! ? i : best), 0)
    ]!;
  const anySame = (text: string) => accepted.some((ref) => sameWords(text, ref));
  const finalText = session.cleanup?.text ?? session.raw;
  const firstOf = (type: PipelineEvent["type"]) =>
    session.events.find(
      (event) => event.type === type && "text" in event && event.text.trim() !== ""
    )?.at ?? null;
  const completes = session.events.filter(
    (event): event is Extract<PipelineEvent, { type: "complete" }> =>
      event.type === "complete" && event.text.trim() !== ""
  );
  const lastFinal = completes.at(-1)?.at ?? null;
  const cleanup = session.cleanup;
  const costs = cleanup?.usage.map((usage) => requestCost(model, usage)) ?? [];
  const literal = (text: string) => terms.filter((term) => literalTerm(term, text)).length;
  return {
    session,
    rawScore: bestClip(session.raw),
    finalScore: bestClip(finalText),
    rawExact: anySame(session.raw),
    finalExact: anySame(finalText),
    rawForm: bestForm(session.raw),
    finalForm: bestForm(finalText),
    rawLiteralTerms: literal(session.raw),
    finalLiteralTerms: literal(finalText),
    termsTotal: terms.length,
    costComplete: (cleanup?.usageMissing ?? 0) === 0,
    brokenWords: brokenWords(finalReference, session.raw, finalText),
    verdict: cleanup?.verdict ?? "none",
    shownAtStop: shownAtStop(session),
    stopPreview: stopPreviewFate(session),
    errored:
      session.startError !== null ||
      session.events.some((event) => event.type === "error") ||
      session.reconnects > 0 ||
      session.droppedConnect > 0,
    firstDeltaMs: firstOf("delta"),
    firstFinalMs: firstOf("complete"),
    stopToLastFinalMs: lastFinal === null ? null : lastFinal - session.stopMs,
    stopToDrainMs: session.drainEndMs - session.stopMs,
    stopToFirstCleanMs:
      cleanup?.firstTextAt == null || cleanup.verdict !== "replaced"
        ? null
        : Math.max(0, cleanup.firstTextAt - session.stopMs),
    stopToSettledMs: Math.max(0, (cleanup?.doneAt ?? session.drainEndMs) - session.stopMs),
    cost: costs.length > 0 && costs.every((cost) => cost !== null) ? sum(costs as number[]) : null,
  };
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

export interface Stat {
  p50: number | null;
  p95: number | null;
  n: number;
}

function stat(values: ReadonlyArray<number | null>): Stat {
  const present = values.filter((value): value is number => value !== null);
  return { p50: percentile(present, 50), p95: percentile(present, 95), n: present.length };
}

export interface ArmSummary {
  arm: string;
  sessions: number;
  errored: number;
  rawWer: number;
  finalWer: number;
  rawFormWer: number;
  finalFormWer: number;
  rawFormExactRate: number;
  finalFormExactRate: number;
  rawLiteralTermRecall: number;
  finalLiteralTermRecall: number;
  rawTermRecall: number;
  finalTermRecall: number;
  rawExactRate: number;
  finalExactRate: number;
  brokenWords: number;
  brokenSessions: number;
  /** Share of cleanups by verdict. */
  verdicts: Record<string, number>;
  /** Share of the final words on screen at stop, in percent, p50 and p5 (the laggiest twentieth). */
  shownAtStop: { p50: number | null; p5: number | null };
  firstDeltaMs: Stat;
  stopToLastFinalMs: Stat;
  stopToDrainMs: Stat;
  stopToFirstCleanMs: Stat;
  stopToSettledMs: Stat;
  speculationAdopted: number;
  requestsPerSession: number;
  costPerSession: number | null;
  /** A request went out without reporting usage, so the cost is a floor. */
  costIsFloor: boolean;
}

function pooledWer(scores: readonly ClipScore[]): number {
  const words = sum(scores.map((score) => score.referenceWords));
  const edits = sum(scores.map((s) => s.substitutions + s.deletions + s.insertions));
  return words === 0 ? 0 : edits / words;
}

function pooledFormWer(scores: readonly FormScore[]): number {
  const words = sum(scores.map((score) => score.words));
  return words === 0 ? 0 : sum(scores.map((score) => score.edits)) / words;
}

function termRecall(scores: readonly ClipScore[]): number {
  const total = sum(scores.map((score) => score.termsTotal));
  return total === 0 ? 1 : sum(scores.map((score) => score.termsRecalled)) / total;
}

export function sessionKey(session: PipelineSession): string {
  return `${session.clip}|${session.voice}|${session.pass}|${session.stopTailMs}`;
}

/**
 * Per arm, over the dictations every arm completed, so a session one arm lost
 * can't flatter it.
 */
export function summarisePipeline(
  scored: readonly ScoredPipelineSession[],
  arms: readonly string[]
): ArmSummary[] {
  const sharedKeys = sharedSessions(scored, arms);
  return arms.map((arm) => {
    const rows = scored.filter(
      (s) => s.session.arm === arm && sharedKeys.has(sessionKey(s.session))
    );
    const n = rows.length || 1;
    const costs = rows.map((row) => row.cost);
    const cleaned = rows.filter((row) => row.session.cleanup);
    const termsTotal = sum(rows.map((row) => row.termsTotal));
    const verdicts: Record<string, number> = {};
    for (const row of cleaned) verdicts[row.verdict] = (verdicts[row.verdict] ?? 0) + 1;
    for (const key of Object.keys(verdicts)) verdicts[key]! /= cleaned.length;
    const shown = rows.flatMap((row) => (row.shownAtStop === null ? [] : [row.shownAtStop * 100]));
    return {
      arm,
      sessions: rows.length,
      errored: rows.filter((row) => row.errored).length,
      rawWer: pooledWer(rows.map((row) => row.rawScore)),
      finalWer: pooledWer(rows.map((row) => row.finalScore)),
      rawFormWer: pooledFormWer(rows.map((row) => row.rawForm)),
      finalFormWer: pooledFormWer(rows.map((row) => row.finalForm)),
      rawFormExactRate: rows.filter((row) => row.rawForm.exact).length / n,
      finalFormExactRate: rows.filter((row) => row.finalForm.exact).length / n,
      rawLiteralTermRecall:
        termsTotal === 0 ? 1 : sum(rows.map((row) => row.rawLiteralTerms)) / termsTotal,
      finalLiteralTermRecall:
        termsTotal === 0 ? 1 : sum(rows.map((row) => row.finalLiteralTerms)) / termsTotal,
      rawTermRecall: termRecall(rows.map((row) => row.rawScore)),
      finalTermRecall: termRecall(rows.map((row) => row.finalScore)),
      rawExactRate: rows.filter((row) => row.rawExact).length / n,
      finalExactRate: rows.filter((row) => row.finalExact).length / n,
      brokenWords: sum(rows.map((row) => row.brokenWords)),
      brokenSessions: rows.filter((row) => row.brokenWords > 0).length,
      verdicts,
      shownAtStop: { p50: percentile(shown, 50), p5: percentile(shown, 5) },
      firstDeltaMs: stat(rows.map((row) => row.firstDeltaMs)),
      stopToLastFinalMs: stat(rows.map((row) => row.stopToLastFinalMs)),
      stopToDrainMs: stat(rows.map((row) => row.stopToDrainMs)),
      stopToFirstCleanMs: stat(rows.map((row) => row.stopToFirstCleanMs)),
      stopToSettledMs: stat(rows.map((row) => row.stopToSettledMs)),
      speculationAdopted: cleaned.length
        ? cleaned.filter((row) => row.session.cleanup!.speculation === "adopted").length /
          cleaned.length
        : 0,
      requestsPerSession: sum(cleaned.map((row) => row.session.cleanup!.requests)) / n,
      costPerSession:
        costs.length > 0 && costs.every((cost) => cost !== null)
          ? sum(costs as number[]) / costs.length
          : null,
      costIsFloor: rows.some((row) => !row.costComplete),
    };
  });
}

/** The dictations every arm completed, by `sessionKey`. */
export function sharedSessions(
  scored: readonly ScoredPipelineSession[],
  arms: readonly string[]
): Set<string> {
  const keysPerArm = arms.map(
    (arm) => new Set(scored.filter((s) => s.session.arm === arm).map((s) => sessionKey(s.session)))
  );
  return new Set([...(keysPerArm[0] ?? [])].filter((key) => keysPerArm.every((k) => k.has(key))));
}

const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
const ms = (value: number | null) => (value === null ? "–" : `${Math.round(value)}`);
const statCell = (s: Stat) => `${ms(s.p50)} / ${ms(s.p95)}`;

/** What reached the draft, raw and after cleanup. */
export function renderAccuracyTable(summaries: readonly ArmSummary[]): string {
  const lines = [
    "| Arm | n | Prompts as written, raw → final | Form WER raw → final | Terms verbatim raw → final | WER raw → final | Broken words (sessions) | Cleanup applied |",
    "| --- | --: | --- | --- | --- | --- | --: | --: |",
  ];
  for (const s of summaries) {
    lines.push(
      `| ${s.arm} | ${s.sessions} | ${pct(s.rawFormExactRate)} → ${pct(s.finalFormExactRate)} | ${pct(s.rawFormWer)} → ${pct(s.finalFormWer)} | ${pct(s.rawLiteralTermRecall)} → ${pct(s.finalLiteralTermRecall)} | ${pct(s.rawWer)} → ${pct(s.finalWer)} | ${s.brokenWords} (${s.brokenSessions}) | ${pct(s.verdicts.replaced ?? 0)} |`
    );
  }
  return lines.join("\n");
}

/** What the speaker saw and waited for. */
export function renderExperienceTable(summaries: readonly ArmSummary[]): string {
  const lines = [
    "| Arm | n | Err | First preview | Shown at stop p50 / p5 | Stop → raw final | Stop → first clean | Stop → settled | Spec kept | Req/session | $/session |",
    "| --- | --: | --: | --- | --- | --- | --- | --- | --: | --: | --: |",
  ];
  for (const s of summaries) {
    lines.push(
      `| ${s.arm} | ${s.sessions} | ${s.errored} | ${statCell(s.firstDeltaMs)} | ${ms(s.shownAtStop.p50)}% / ${ms(s.shownAtStop.p5)}% | ${statCell(s.stopToDrainMs)} | ${statCell(s.stopToFirstCleanMs)} | ${statCell(s.stopToSettledMs)} | ${pct(s.speculationAdopted)} | ${s.requestsPerSession.toFixed(2)} | ${s.costPerSession === null ? "–" : `${s.costIsFloor ? "≥" : ""}$${s.costPerSession.toFixed(5)}`} |`
    );
  }
  return lines.join("\n");
}

export function renderPipelineTable(summaries: readonly ArmSummary[]): string {
  return `${renderAccuracyTable(summaries)}\n\n${renderExperienceTable(summaries)}`;
}

/** Accuracy per voice, for one arm, over the dictations every arm completed. */
export function renderVoiceTable(
  scored: readonly ScoredPipelineSession[],
  arm: string,
  arms: readonly string[] = [arm]
): string {
  const shared = sharedSessions(scored, arms);
  const rows = scored.filter((s) => s.session.arm === arm && shared.has(sessionKey(s.session)));
  const voices = [...new Set(rows.map((s) => s.session.voice))];
  const lines = [
    `| Voice (${arm}) | n | WER raw → final | Form WER raw → final | As written, final |`,
    "| --- | --: | --- | --- | --: |",
  ];
  for (const voice of voices) {
    const mine = rows.filter((s) => s.session.voice === voice);
    lines.push(
      `| ${voice} | ${mine.length} | ${pct(pooledWer(mine.map((s) => s.rawScore)))} → ${pct(pooledWer(mine.map((s) => s.finalScore)))} | ${pct(pooledFormWer(mine.map((s) => s.rawForm)))} → ${pct(pooledFormWer(mine.map((s) => s.finalForm)))} | ${pct(mine.filter((s) => s.finalForm.exact).length / (mine.length || 1))} |`
    );
  }
  return lines.join("\n");
}

export interface StopPreviewSummary {
  sessions: number;
  /** Dictations with something pending at the stop: all but the settled. */
  waited: number;
  match: number;
  command: number;
  file: number;
  /** Matches over the dictations that waited, commands and files counted as misses. */
  exactShare: number | null;
  /** Stop to the drain's end, when the stop's own cleanup goes out, over the dictations that waited. */
  stopToFinalMs: Stat;
}

export function summariseStopPreview(rows: readonly ScoredPipelineSession[]): StopPreviewSummary {
  const waited = rows.filter((row) => row.stopPreview !== "settled");
  const count = (fate: StopPreviewFate) => rows.filter((row) => row.stopPreview === fate).length;
  return {
    sessions: rows.length,
    waited: waited.length,
    match: count("match"),
    command: count("command"),
    file: count("file"),
    exactShare: waited.length === 0 ? null : count("match") / waited.length,
    stopToFinalMs: stat(waited.map((row) => row.stopToDrainMs)),
  };
}

/**
 * Whether the text at the stop is the text the final commits, for one arm,
 * per stop tail and voice, then every stop together (#15076). A cleanup
 * started at the stop and kept on an exact match would save the wait from the
 * stop to the final, so that wait is timed over the dictations that had one.
 */
export function renderStopPreviewTable(
  scored: readonly ScoredPipelineSession[],
  arm: string,
  arms: readonly string[] = [arm]
): string {
  const shared = sharedSessions(scored, arms);
  const rows = scored.filter((s) => s.session.arm === arm && shared.has(sessionKey(s.session)));
  const tails = [...new Set(rows.map((s) => s.session.stopTailMs))].sort((a, b) => a - b);
  const voices = [...new Set(rows.map((s) => s.session.voice))];
  const lines = [
    `| Tail | Voice (${arm}) | n | Waited | Exact | Command | File | Exact of waited | Stop → final, waited |`,
    "| --- | --- | --: | --: | --: | --: | --: | --: | --- |",
  ];
  const row = (tail: string, voice: string, mine: readonly ScoredPipelineSession[]) => {
    const s = summariseStopPreview(mine);
    lines.push(
      `| ${tail} | ${voice} | ${s.sessions} | ${s.waited} | ${s.match} | ${s.command} | ${s.file} | ${s.exactShare === null ? "–" : pct(s.exactShare)} | ${statCell(s.stopToFinalMs)} |`
    );
  };
  for (const tail of tails) {
    const atTail = rows.filter((s) => s.session.stopTailMs === tail);
    for (const voice of voices) {
      const mine = atTail.filter((s) => s.session.voice === voice);
      if (mine.length > 0) row(`${tail} ms`, voice, mine);
    }
    row(`${tail} ms`, "all", atTail);
  }
  row("all", "all", rows);
  return lines.join("\n");
}

/**
 * What the word scores can't see, for the `--intent` clips: whether a
 * question came back a question and a statement a statement, and whether the
 * words the speaker gave to be used exactly came back quoted. Null where the
 * clip doesn't test it.
 */
export interface IntentCheck {
  question: boolean | null;
  quotes: boolean | null;
}

// A quoted span counts as the reference's when this share of its words line up.
const QUOTE_MATCH = 0.8;

function straightQuotes(text: string): string {
  return text.replace(/[“”]/g, '"');
}

export function quotedSpans(text: string): string[] {
  return [...straightQuotes(text).matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
}

function quoteMatches(reference: string, hypothesis: string): boolean {
  const ref = normaliseWords(reference);
  const alignment = alignWords(ref, normaliseWords(hypothesis));
  const errors = alignment.substitutions + alignment.deletions + alignment.insertions;
  return ref.length > 0 && 1 - errors / ref.length >= QUOTE_MATCH;
}

// Each reference sentence, by its last word, against the sentence of the text
// that word lands in, read forward so a repeated word finds its own place.
function questionsKept(reference: string, text: string): boolean {
  const sentences = (value: string) =>
    value
      .split(/(?<=[.?!])\s+/)
      .map((sentence) => ({
        words: normaliseWords(sentence),
        asks: sentence.trimEnd().endsWith("?"),
      }))
      .filter((sentence) => sentence.words.length > 0);
  const said = sentences(text);
  let at = 0;
  for (const sentence of sentences(reference)) {
    const last = sentence.words[sentence.words.length - 1]!;
    while (at < said.length && !said[at]!.words.includes(last)) at++;
    if (at === said.length || said[at]!.asks !== sentence.asks) return false;
  }
  return true;
}

export function checkIntent(reference: string, text: string, tags: readonly string[]): IntentCheck {
  const question = tags.includes("question") ? questionsKept(reference, text) : null;
  let quotes: boolean | null = null;
  if (tags.includes("quote")) {
    const want = quotedSpans(reference);
    const got = quotedSpans(text);
    // In order and one for one, so a label quoted twice or swapped doesn't pass.
    quotes = want.length === got.length && want.every((span, i) => quoteMatches(span, got[i]!));
  }
  return { question, quotes };
}
