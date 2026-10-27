import { alignWords, normaliseWords } from "../../../e2e/helpers/voiceReplayScore";

/**
 * Scoring for `npm run perf voice-preview-final` (#14852): where OpenAI's
 * final transcript of a segment reads differently from the live preview the
 * delta stream showed for it, and whether those words are the ones the final
 * got wrong. Pure, so the run, `--rescore` and the unit tests share it.
 */

export const VOICE_PREVIEW_FINAL_SCHEMA_VERSION = 1;
export const VOICE_PREVIEW_FINAL_SCORING_VERSION = 1;

/** `gpt-live-transcribe` bills streamed audio by duration (OpenAI pricing, October 2026). */
export const LIVE_TRANSCRIBE_USD_PER_MINUTE = 0.017;

/** A provider event as the run recorded it, with transcript text kept only in `.tmp/`. */
export type ObservedEvent =
  | { at: number; type: "delta"; itemId: string | null; text: string }
  | {
      at: number;
      type: "complete";
      itemId: string | null;
      text: string;
      endOfSpeech: boolean;
      endsAtPause: boolean;
      incomplete: boolean;
    }
  | { at: number; type: "error"; code: string }
  | { at: number; type: "status"; status: string };

export interface VadObservation {
  forks: number;
  ready: number;
  speechStarts: number;
  speechEnds: number;
  errors: number;
  /** Children that exited before the provider asked them to. */
  unexpectedExits: number;
}

export interface SessionObservation {
  clip: string;
  pass: number;
  startResult: { ok: boolean; error?: string };
  events: ObservedEvent[];
  vad: VadObservation;
  reconnects: number;
  droppedConnect: number;
  droppedReplay: number;
  audioMs: number;
  /** Start to `status: recording` (the socket's session ready), null if it never got there. */
  readyMs: number | null;
  /** The pump's worst lateness against a 100 ms capture clock. */
  maxChunkLateMs: number;
  /** `stopGracefully()` call to its return. */
  drainMs: number;
}

export interface Segment {
  itemId: string;
  /** Every delta for the item before its completion, joined as the renderer joins them. */
  preview: string;
  deltas: number;
  final: string;
  endsAtPause: boolean;
  endOfSpeech: boolean;
}

/**
 * The segments of a session in completion order, and every reason it can't be
 * scored. A session is scored whole or not at all: dropping one segment and
 * aligning the rest against the full reference would invent omissions.
 */
export function collectSegments(observation: SessionObservation): {
  segments: Segment[];
  anomalies: string[];
} {
  const anomalies = new Set<string>();
  if (!observation.startResult.ok) anomalies.add("start failed");
  if (observation.reconnects > 0) anomalies.add("reconnected");
  if (observation.droppedConnect > 0 || observation.droppedReplay > 0)
    anomalies.add("audio dropped");
  const vad = observation.vad;
  if (vad.forks === 0 || vad.ready === 0) anomalies.add("VAD never ready");
  if (vad.errors > 0 || vad.unexpectedExits > 0) anomalies.add("VAD failed");

  const previews = new Map<string, { text: string; deltas: number }>();
  const segments: Segment[] = [];
  const completed = new Set<string>();
  for (const event of observation.events) {
    if (event.type === "error") anomalies.add(`error ${event.code}`);
    else if (event.type === "delta") {
      if (event.itemId === null) {
        anomalies.add("delta without an item");
        continue;
      }
      if (completed.has(event.itemId)) {
        anomalies.add("delta after its completion");
        continue;
      }
      const preview = previews.get(event.itemId) ?? { text: "", deltas: 0 };
      preview.text += event.text;
      preview.deltas++;
      previews.set(event.itemId, preview);
    } else if (event.type === "complete") {
      if (event.itemId === null) {
        anomalies.add("completion without an item");
        continue;
      }
      if (event.incomplete) anomalies.add("segment settled without a final");
      if (completed.has(event.itemId)) {
        anomalies.add("item completed twice");
        continue;
      }
      completed.add(event.itemId);
      const preview = previews.get(event.itemId);
      segments.push({
        itemId: event.itemId,
        preview: preview?.text ?? "",
        deltas: preview?.deltas ?? 0,
        final: event.text,
        endsAtPause: event.endsAtPause,
        endOfSpeech: event.endOfSpeech,
      });
    }
  }
  for (const itemId of previews.keys()) {
    if (!completed.has(itemId)) anomalies.add("preview never finalised");
  }
  if (segments.length === 0) anomalies.add("no segment");
  return { segments, anomalies: [...anomalies] };
}

/**
 * How a run of final words differs from the preview between two matched
 * words. `drop` has preview words and no final ones, so nothing to flag.
 * `suffix` is final words after the last match that the preview never showed;
 * `no-preview` is a segment whose preview had no words at all.
 */
export type SpanKind = "changed" | "spacing" | "inserted" | "suffix" | "no-preview" | "drop";

export const SPAN_KINDS: readonly SpanKind[] = [
  "changed",
  "spacing",
  "inserted",
  "suffix",
  "no-preview",
  "drop",
];

export interface Span {
  kind: SpanKind;
  previewWords: string[];
  finalWords: string[];
  /** Index into the segment's final words of the span's first word. */
  finalStart: number;
}

/**
 * The edit spans between matched words of `preview` → `final`, each with its
 * kind. Matches pair up in order, so the k-th matched preview word and the
 * k-th matched final word are the same anchor.
 */
export function disagreementSpans(preview: readonly string[], final: readonly string[]): Span[] {
  const { referenceOps, hypothesisOps } = alignWords(preview, final);
  if (preview.length === 0) {
    return final.length === 0
      ? []
      : [{ kind: "no-preview", previewWords: [], finalWords: [...final], finalStart: 0 }];
  }
  const spans: Span[] = [];
  let p = 0;
  let f = 0;
  for (;;) {
    const pStart = p;
    const fStart = f;
    while (p < preview.length && referenceOps[p] !== "match") p++;
    while (f < final.length && hypothesisOps[f] !== "match") f++;
    const previewWords = preview.slice(pStart, p);
    const finalWords = final.slice(fStart, f);
    if (previewWords.length > 0 || finalWords.length > 0) {
      const trailing = p === preview.length && f === final.length;
      const kind: SpanKind =
        finalWords.length === 0
          ? "drop"
          : previewWords.length === 0
            ? trailing
              ? "suffix"
              : "inserted"
            : previewWords.join("") === finalWords.join("")
              ? "spacing"
              : "changed";
      spans.push({ kind, previewWords, finalWords, finalStart: fStart });
    }
    if (p === preview.length && f === final.length) return spans;
    // Step over the anchor both sides share.
    p++;
    f++;
  }
}

/**
 * Lowercase and punctuation dropped, nothing else: the literal reading of
 * "casing and punctuation set aside", to show how much of the headline
 * depends on the replay normaliser's spacing and number rules.
 */
export function literalWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .split(/\s+/u)
    .filter((word) => word.length > 0);
}

/**
 * Which final words a policy would tag for cleanup. Fixed before the run, so
 * the verdict can't be a condition picked after seeing the numbers.
 */
export const POLICIES = {
  any: {
    label: "Every word the preview didn't have",
    kinds: ["changed", "spacing", "inserted", "suffix", "no-preview"],
  },
  substituted: {
    label: "Words that replaced preview words",
    kinds: ["changed", "spacing"],
  },
  changed: {
    label: "Replaced preview words, spacing changes left out",
    kinds: ["changed"],
  },
  interior: {
    label: "Replaced or inserted words, spacing and suffixes left out",
    kinds: ["changed", "inserted"],
  },
} as const satisfies Record<string, { label: string; kinds: readonly SpanKind[] }>;

export type PolicyId = keyof typeof POLICIES;
export const POLICY_IDS = Object.keys(POLICIES) as PolicyId[];

export interface FinalWord {
  word: string;
  segment: number;
  /** The final word is a substitution or insertion against the clip's reference. */
  wrong: boolean;
  /** The kind of span the word sits in against the preview, null when it matched. */
  kind: Exclude<SpanKind, "drop"> | null;
}

export interface SessionScore {
  clip: string;
  pass: number;
  segments: number;
  /** Segments with any span, drops included. */
  segmentsDisagreeing: number;
  /** Segments with any span under the literal normaliser. */
  segmentsDisagreeingLiteral: number;
  words: FinalWord[];
  /** Final words in a span under the literal normaliser. */
  literalDisagreeingWords: number;
  /** Reference words the final left out: errors with no final word to tag. */
  referenceDeletions: number;
  referenceWords: number;
  spans: Array<Span & { segment: number; wrongWords: number }>;
}

/**
 * Scores one clean session. Each segment is normalised on its own and the
 * word lists are joined, so no spelled-out run merges across a segment cut;
 * the reference is aligned against the joined finals once, and each final
 * word's right or wrong is carried back to its segment.
 */
export function scoreSession(
  observation: Pick<SessionObservation, "clip" | "pass">,
  segments: readonly Segment[],
  reference: string
): SessionScore {
  const words: FinalWord[] = [];
  const spans: SessionScore["spans"] = [];
  let segmentsDisagreeing = 0;
  let segmentsDisagreeingLiteral = 0;
  let literalDisagreeingWords = 0;
  // Where each span's first final word sits in the session's joined words.
  const spanStarts: number[] = [];
  segments.forEach((segment, index) => {
    const preview = normaliseWords(segment.preview);
    const final = normaliseWords(segment.final);
    const kinds = new Array<FinalWord["kind"]>(final.length).fill(null);
    const segmentSpans = disagreementSpans(preview, final);
    if (segmentSpans.length > 0) segmentsDisagreeing++;
    for (const span of segmentSpans) {
      spans.push({ ...span, segment: index, wrongWords: 0 });
      spanStarts.push(words.length + span.finalStart);
      if (span.kind === "drop") continue;
      for (let k = 0; k < span.finalWords.length; k++) kinds[span.finalStart + k] = span.kind;
    }
    final.forEach((word, k) => words.push({ word, segment: index, wrong: false, kind: kinds[k]! }));

    const literal = disagreementSpans(literalWords(segment.preview), literalWords(segment.final));
    if (literal.length > 0) segmentsDisagreeingLiteral++;
    literalDisagreeingWords += literal.reduce((n, span) => n + span.finalWords.length, 0);
  });

  const referenceWords = normaliseWords(reference);
  const alignment = alignWords(
    referenceWords,
    words.map((entry) => entry.word)
  );
  alignment.hypothesisOps.forEach((op, i) => {
    words[i]!.wrong = op !== "match";
  });
  spans.forEach((span, i) => {
    const start = spanStarts[i]!;
    span.wrongWords = words
      .slice(start, start + span.finalWords.length)
      .filter((word) => word.wrong).length;
  });

  return {
    clip: observation.clip,
    pass: observation.pass,
    segments: segments.length,
    segmentsDisagreeing,
    segmentsDisagreeingLiteral,
    words,
    literalDisagreeingWords,
    referenceDeletions: alignment.deletions,
    referenceWords: referenceWords.length,
    spans,
  };
}

export interface PolicyScore {
  policy: PolicyId;
  finalWords: number;
  wrongWords: number;
  flagged: number;
  flaggedWrong: number;
  flaggedRight: number;
  /** Wrong final words no flag covers: what this policy can't catch. */
  missed: number;
  /** flaggedWrong / flagged; null with nothing flagged. */
  precision: number | null;
  /** flaggedWrong / wrongWords; null with nothing wrong. */
  recall: number | null;
  /** Precision over the base wrong-word rate: 1 is no better than tagging words at random. */
  lift: number | null;
}

const ratio = (numerator: number, denominator: number): number | null =>
  denominator === 0 ? null : numerator / denominator;

export function scorePolicy(policy: PolicyId, sessions: readonly SessionScore[]): PolicyScore {
  const kinds: readonly SpanKind[] = POLICIES[policy].kinds;
  let finalWords = 0;
  let wrongWords = 0;
  let flagged = 0;
  let flaggedWrong = 0;
  for (const session of sessions) {
    for (const word of session.words) {
      finalWords++;
      if (word.wrong) wrongWords++;
      if (word.kind === null || !kinds.includes(word.kind)) continue;
      flagged++;
      if (word.wrong) flaggedWrong++;
    }
  }
  const precision = ratio(flaggedWrong, flagged);
  const base = ratio(wrongWords, finalWords);
  return {
    policy,
    finalWords,
    wrongWords,
    flagged,
    flaggedWrong,
    flaggedRight: flagged - flaggedWrong,
    missed: wrongWords - flaggedWrong,
    precision,
    recall: ratio(flaggedWrong, wrongWords),
    lift: precision === null || !base ? null : precision / base,
  };
}

export interface KindScore {
  kind: SpanKind;
  spans: number;
  previewWords: number;
  finalWords: number;
  wrongWords: number;
}

export function scoreKinds(sessions: readonly SessionScore[]): KindScore[] {
  return SPAN_KINDS.map((kind) => {
    const spans = sessions.flatMap((session) => session.spans.filter((s) => s.kind === kind));
    return {
      kind,
      spans: spans.length,
      previewWords: spans.reduce((n, span) => n + span.previewWords.length, 0),
      finalWords: spans.reduce((n, span) => n + span.finalWords.length, 0),
      wrongWords: spans.reduce((n, span) => n + span.wrongWords, 0),
    };
  });
}

export interface RunSummary {
  sessions: number;
  scored: number;
  excluded: Array<{ clip: string; pass: number; reasons: string[] }>;
  segments: number;
  segmentsDisagreeing: number;
  segmentsDisagreeingLiteral: number;
  finalWords: number;
  /** Final words in any span: the `any` policy's flags. */
  disagreeingWords: number;
  literalDisagreeingWords: number;
  referenceWords: number;
  referenceDeletions: number;
  /** (substitutions + deletions + insertions) / reference words, over the scored sessions. */
  wer: number | null;
  policies: PolicyScore[];
  kinds: KindScore[];
}

export function summarise(
  observations: readonly SessionObservation[],
  scored: readonly SessionScore[],
  excluded: RunSummary["excluded"]
): RunSummary {
  const sum = (pick: (session: SessionScore) => number) =>
    scored.reduce((n, session) => n + pick(session), 0);
  const policies = POLICY_IDS.map((id) => scorePolicy(id, scored));
  const any = policies.find((policy) => policy.policy === "any")!;
  const referenceWords = sum((s) => s.referenceWords);
  const referenceDeletions = sum((s) => s.referenceDeletions);
  return {
    sessions: observations.length,
    scored: scored.length,
    excluded: [...excluded],
    segments: sum((s) => s.segments),
    segmentsDisagreeing: sum((s) => s.segmentsDisagreeing),
    segmentsDisagreeingLiteral: sum((s) => s.segmentsDisagreeingLiteral),
    finalWords: any.finalWords,
    disagreeingWords: any.flagged,
    literalDisagreeingWords: sum((s) => s.literalDisagreeingWords),
    referenceWords,
    referenceDeletions,
    wer: ratio(any.wrongWords + referenceDeletions, referenceWords),
    policies,
    kinds: scoreKinds(scored),
  };
}

/** Scores every clean session of a run against the references it was given. */
export function scoreRun(
  observations: readonly SessionObservation[],
  references: ReadonlyMap<string, string>
): { summary: RunSummary; scored: SessionScore[] } {
  const scored: SessionScore[] = [];
  const excluded: RunSummary["excluded"] = [];
  for (const observation of observations) {
    const { segments, anomalies } = collectSegments(observation);
    const reference = references.get(observation.clip);
    if (reference === undefined) anomalies.push("clip has no reference");
    if (anomalies.length > 0) {
      excluded.push({ clip: observation.clip, pass: observation.pass, reasons: anomalies });
      continue;
    }
    scored.push(scoreSession(observation, segments, reference!));
  }
  return { summary: summarise(observations, scored, excluded), scored };
}

const pct = (value: number | null) => (value === null ? "–" : `${(value * 100).toFixed(1)}%`);
const times = (value: number | null) => (value === null ? "–" : `${value.toFixed(2)}×`);

function policyRow(p: PolicyScore): string {
  return `| \`${p.policy}\` | ${p.flagged} | ${pct(ratio(p.flagged, p.finalWords))} | ${p.flaggedWrong} | ${p.flaggedRight} | ${pct(p.precision)} | ${p.missed} | ${pct(p.recall)} | ${times(p.lift)} |`;
}

const POLICY_HEADER = [
  "| Policy | Flagged | of final words | Wrong | Right | Precision | Wrong, unflagged | Recall | Lift |",
  "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
];

export interface ReportMeta {
  label: string;
  startedAt: string;
  revision: string;
  dirty: boolean;
  passes: number;
  terms: boolean;
  complete: boolean;
  audioMs: number;
}

/**
 * The Markdown report. It quotes previews and finals, so it is written beside
 * the run in `.tmp/` and never printed: `renderHeadline` is what reaches the terminal.
 */
export function renderReport(
  meta: ReportMeta,
  observations: readonly SessionObservation[],
  summary: RunSummary,
  scored: readonly SessionScore[]
): string {
  const lines: string[] = [];
  const minutes = meta.audioMs / 60_000;
  lines.push(
    `# OpenAI preview against final: ${meta.label}`,
    "",
    `${meta.startedAt} · ${meta.revision.slice(0, 10)}${meta.dirty ? " (dirty)" : ""} · ${meta.passes} pass(es) · bias terms ${meta.terms ? "on" : "off"} · ${minutes.toFixed(1)} min of audio (~$${(minutes * LIVE_TRANSCRIBE_USD_PER_MINUTE).toFixed(3)})${meta.complete ? "" : " · **incomplete**"}`,
    "",
    ...renderHeadline(summary),
    "",
    "## Policies",
    "",
    "Each policy tags a fixed set of span kinds. Wrong and right are the tagged final words against the clip's reference; wrong, unflagged is what the policy can't catch. Lift is precision over the base wrong-word rate, so 1× is no better than tagging words at random.",
    "",
    ...POLICY_HEADER,
    ...summary.policies.map(policyRow),
    "",
    "## Span kinds",
    "",
    "| Kind | Spans | Preview words | Final words | Wrong final words |",
    "| --- | --- | --- | --- | --- |",
    ...summary.kinds.map(
      (k) => `| ${k.kind} | ${k.spans} | ${k.previewWords} | ${k.finalWords} | ${k.wrongWords} |`
    ),
    "",
    "## By pass",
    "",
    "| Pass | Sessions | Final words | Wrong | `any` flagged | wrong | precision | recall | `changed` flagged | wrong |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"
  );
  for (const pass of [...new Set(scored.map((s) => s.pass))].sort((a, b) => a - b)) {
    const rows = scored.filter((s) => s.pass === pass);
    const any = scorePolicy("any", rows);
    const changed = scorePolicy("changed", rows);
    lines.push(
      `| ${pass} | ${rows.length} | ${any.finalWords} | ${any.wrongWords} | ${any.flagged} | ${any.flaggedWrong} | ${pct(any.precision)} | ${pct(any.recall)} | ${changed.flagged} | ${changed.flaggedWrong} |`
    );
  }
  lines.push(
    "",
    "## By clip",
    "",
    "| Clip | Sessions | Segments | Final words | Wrong | Sessions with a flag | `any` flagged | wrong | `changed` flagged | wrong |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"
  );
  for (const clip of [...new Set(observations.map((o) => o.clip))]) {
    const rows = scored.filter((s) => s.clip === clip);
    const any = scorePolicy("any", rows);
    const changed = scorePolicy("changed", rows);
    const flaggedSessions = rows.filter((s) => s.words.some((w) => w.kind !== null)).length;
    const total = observations.filter((o) => o.clip === clip).length;
    lines.push(
      `| ${clip} | ${rows.length}/${total} | ${rows.reduce((n, s) => n + s.segments, 0)} | ${any.finalWords} | ${any.wrongWords} | ${flaggedSessions} | ${any.flagged} | ${any.flaggedWrong} | ${changed.flagged} | ${changed.flaggedWrong} |`
    );
  }

  const ms = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    if (sorted.length === 0) return "–";
    return `${Math.round(sorted[Math.floor((sorted.length - 1) / 2)]!)} / ${Math.round(sorted[sorted.length - 1]!)}`;
  };
  lines.push(
    "",
    "## Run health",
    "",
    "Median / max over every session.",
    "",
    `- Start to session ready: ${ms(observations.flatMap((o) => (o.readyMs === null ? [] : [o.readyMs])))} ms`,
    `- Worst chunk lateness against the 100 ms capture clock: ${ms(observations.map((o) => o.maxChunkLateMs))} ms`,
    `- Stop to drained: ${ms(observations.map((o) => o.drainMs))} ms`,
    `- VAD: ready in ${observations.filter((o) => o.vad.ready > 0).length}/${observations.length} sessions, ${observations.reduce((n, o) => n + o.vad.speechEnds, 0)} speech ends`,
    ""
  );
  if (summary.excluded.length > 0) {
    lines.push("## Excluded sessions", "", "| Clip | Pass | Why |", "| --- | --- | --- |");
    for (const entry of summary.excluded) {
      lines.push(`| ${entry.clip} | ${entry.pass} | ${entry.reasons.join(", ")} |`);
    }
    lines.push("");
  }

  lines.push(
    "## Every span",
    "",
    "Normalised words, preview → final, with how many of the final's words are wrong against the reference.",
    ""
  );
  for (const session of scored) {
    for (const span of session.spans) {
      lines.push(
        `- ${session.clip} #${session.pass} seg ${span.segment + 1} · ${span.kind} · ${JSON.stringify(span.previewWords.join(" "))} → ${JSON.stringify(span.finalWords.join(" "))} · ${span.wrongWords}/${span.finalWords.length} wrong`
      );
    }
  }
  return lines.join("\n");
}

/** Counts only, no transcript text: safe for the terminal. */
export function renderHeadline(summary: RunSummary): string[] {
  const any = summary.policies.find((p) => p.policy === "any")!;
  return [
    `Scored ${summary.scored} of ${summary.sessions} sessions (${summary.excluded.length} excluded), ${summary.segments} segments, ${summary.finalWords} final words, WER ${pct(summary.wer)}.`,
    "",
    `- Segments where the final disagrees with the preview: ${summary.segmentsDisagreeing}/${summary.segments} (${pct(ratio(summary.segmentsDisagreeing, summary.segments))}); ${summary.segmentsDisagreeingLiteral} under the literal normaliser.`,
    `- Final words in a disagreement: ${summary.disagreeingWords}/${summary.finalWords} (${pct(ratio(summary.disagreeingWords, summary.finalWords))}); ${summary.literalDisagreeingWords} under the literal normaliser.`,
    `- Of those, wrong against the reference: ${any.flaggedWrong}; right: ${any.flaggedRight} (precision ${pct(any.precision)}, ${times(any.lift)} the base rate of ${pct(ratio(any.wrongWords, any.finalWords))}).`,
    `- The final's wrong words: ${any.wrongWords}; outside every disagreement: ${any.missed} (recall ${pct(any.recall)}). Reference words the final left out: ${summary.referenceDeletions}.`,
  ];
}
