import { pluralize } from "@/lib/pluralize";
import type { DecisionsModelAdapter } from "@shared/types/decisions";
import type {
  DecisionsModelBucket,
  DecisionsModelHistory,
  DecisionsModelRun,
  DecisionsModelState,
  DecisionsModelThreshold,
} from "@shared/types/decisionsModel";

interface AdapterFacts {
  label: string;
  /** Who the CLI's requests go to. */
  provider: string;
  command: string;
}

/** The CLIs the model can run, each with where its requests go. */
export const MODEL_ADAPTERS: Record<DecisionsModelAdapter, AdapterFacts> = {
  claude: { label: "Claude Code", provider: "Anthropic", command: "claude" },
  codex: { label: "Codex CLI", provider: "OpenAI", command: "codex" },
  gemini: { label: "Gemini CLI", provider: "Google", command: "gemini" },
};

/** The radio's value for "no CLI". */
export const NO_ADAPTER = "none";

export type AdapterChoice = DecisionsModelAdapter | typeof NO_ADAPTER;

/**
 * Where a CLI's requests go: its usual provider, though the CLI's own
 * settings decide, since it runs as installed and signed in here.
 */
export function providerText(adapter: DecisionsModelAdapter): string {
  return `${MODEL_ADAPTERS[adapter].provider}, or wherever that CLI is set up to send`;
}

/** What each choice sends, and where: the plain statement the person chooses by. */
export function adapterChoiceDescription(choice: AdapterChoice): string {
  if (choice === NO_ADAPTER) {
    return "Keeps learning from your answers on this computer. Nothing is sent, and the model never answers.";
  }
  const { command } = MODEL_ADAPTERS[choice];
  return `Runs the ${command} command installed here with its own sign-in, which sends the question and your past answers like it to ${providerText(choice)}.`;
}

/** A confidence as the model reports it: its own estimate, to two places. */
export function confidenceText(value: number): string {
  return value.toFixed(2);
}

/** "41 of 45 (91%)"; the share is left out when there is nothing to divide by. */
export function matchedText(matched: number, answered: number): string {
  if (answered === 0) return "none answered";
  return `${matched} of ${answered} (${Math.round((matched / answered) * 100)}%)`;
}

/** A band's range; the last one holds its upper bound. */
export function bucketRangeText(bucket: DecisionsModelBucket, last: boolean): string {
  return `${confidenceText(bucket.lo)} to ${last ? "" : "under "}${confidenceText(bucket.hi)}`;
}

/** A threshold as the person chooses it, with the replay's evidence. */
export function thresholdChoiceText(choice: DecisionsModelThreshold): string {
  const from =
    choice.threshold === 0
      ? "At any confidence"
      : `At confidence ${confidenceText(choice.threshold)} or higher`;
  return `${from}: matched ${matchedText(choice.matched, choice.answered)}`;
}

/** The history as observed. */
export function historyText(history: DecisionsModelHistory): string {
  switch (history.state) {
    case "open":
      return history.count === 0
        ? "Nothing learned yet. Questions you answer from your phone are kept from now on."
        : `Holds ${pluralize(history.count, "answer")} you gave from your phone.`;
    case "closed":
      return history.stored
        ? "Learning is off. What it learned is still stored on this computer."
        : "Nothing is stored.";
    case "unavailable":
      return "The history couldn't be opened, so nothing new is being kept.";
  }
}

/** How an evaluation running now reads. */
export function runText(run: DecisionsModelRun, startedAt: string): string {
  const { label } = MODEL_ADAPTERS[run.adapter];
  return `Replaying ${pluralize(run.historyCount, "past answer")} through ${label} since ${startedAt}, which sends them to ${providerText(run.adapter)}. It goes on if you close Settings.`;
}

/** What answers automatically now, as main observes it. */
export function answeringText(
  model: Pick<DecisionsModelState, "answeringFrom" | "adapter">,
  proxyAllowlisted: boolean
): string {
  if (model.answeringFrom === null || model.adapter === null) {
    return "The model doesn't answer anything. Every question waits for you.";
  }
  const { label } = MODEL_ADAPTERS[model.adapter];
  const from =
    model.answeringFrom === 0
      ? "at any confidence"
      : `when its confidence is ${confidenceText(model.answeringFrom)} or higher`;
  const scope = proxyAllowlisted
    ? "Only questions whose agent allows a proxy answer, and never a gate only you can answer."
    : "Only questions whose gate allows a proxy answer. Questions without a gate still need you while Allow proxy answers is off under Policy.";
  return `Answers in your place through ${label} ${from}, labelled as a proxy's answer. ${scope}`;
}

/** The library's reasons for giving no answer, in words; an unknown code is shown as it is. */
const ABSTAIN_REASONS: Record<string, string> = {
  "insufficient-history": "too few similar past answers",
  "contradictory-history": "past answers disagreed",
  "stale-history": "the history changed while it was asked",
  "model-abstained": "the model chose not to answer",
  "model-error": "the CLI failed or timed out",
  "engine-error": "the model failed",
  "invalid-model-output": "the CLI's reply couldn't be read",
  "ambiguous-options": "the options were ambiguous",
  "prompt-injection-flagged": "the question looked like it tried to steer the answer",
  "prompt-injection-suspected": "the question looked like it tried to steer the answer",
  "blocked-gate": "the question's gate is blocked",
  "human-required": "only you could answer",
  "below-threshold": "its confidence was too low",
};

export function abstainReasonText(code: string): string {
  return ABSTAIN_REASONS[code] ?? code;
}

/** The report's headline: how often the replay matched the person, and how often it answered at all. */
export function reportSummary(report: {
  total: number;
  scored: number;
  answered: number;
  matched: number;
}): string {
  if (report.scored === 0) {
    return `None of the ${pluralize(report.total, "past answer")} had a choice among options to compare with, so nothing was scored.`;
  }
  const scored = pluralize(report.scored, "past question");
  if (report.answered === 0) return `The model answered none of ${scored}.`;
  return `Of ${scored} it could compare, the model answered ${report.answered} and matched your answer on ${matchedText(report.matched, report.answered)}.`;
}
