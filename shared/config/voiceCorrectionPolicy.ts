import type { VoiceCorrectionModel, VoiceCorrectionProvider } from "../types/ipc/api.js";

// The cleanup settings and limits, kept apart from the prompts voiceCorrection.ts
// builds so the renderer can read them without bundling the prompt text.

/**
 * The OpenAI model behind file-command detection and ambiguous-file reranking,
 * which run on a 4 s budget. Migrations hard-code their own target literal and
 * must not import this or VOICE_CLEANUP_AI_MODEL — the active model can move
 * again, but a past migration's target is immutable.
 */
export const VOICE_DICTATION_AI_MODEL = "gpt-6-luna" as const;

/**
 * The default OpenAI model behind whole-passage cleanup and spoken rewrite.
 * gpt-6.1-terra replaced gpt-6-luna here on the cleanup benchmark
 * (`npm run perf voice-cleanup`, #14793): it repaired more misheard words at the
 * same reasoning effort, with typical round trips still under 2 s.
 */
export const VOICE_CLEANUP_AI_MODEL = "gpt-6.1-terra" as const;

/** The models cleanup and spoken rewrite may run on; settings let the user pick one. */
export const VOICE_CLEANUP_MODELS = [
  "gpt-6.1-terra",
  "gpt-6-luna",
  "claude-haiku-5-5",
  "claude-sonnet-5-5",
] as const satisfies readonly VoiceCorrectionModel[];

export function isVoiceCleanupModel(value: unknown): value is VoiceCorrectionModel {
  return (VOICE_CLEANUP_MODELS as readonly unknown[]).includes(value);
}

export const VOICE_CLEANUP_PROVIDERS = [
  "openai",
  "anthropic",
] as const satisfies readonly VoiceCorrectionProvider[];

/** Each provider's cleanup models, its default first. */
export const VOICE_CLEANUP_MODELS_BY_PROVIDER: Readonly<
  Record<VoiceCorrectionProvider, readonly VoiceCorrectionModel[]>
> = {
  openai: ["gpt-6.1-terra", "gpt-6-luna"],
  anthropic: ["claude-haiku-5-5", "claude-sonnet-5-5"],
};

export function isVoiceCleanupProvider(value: unknown): value is VoiceCorrectionProvider {
  return (VOICE_CLEANUP_PROVIDERS as readonly unknown[]).includes(value);
}

/** Which API a cleanup model is sent to. Any model id outside Claude's goes to OpenAI. */
export function voiceCleanupProviderOf(model: string): VoiceCorrectionProvider {
  return model.startsWith("claude-") ? "anthropic" : "openai";
}

/**
 * Reasoning effort sent explicitly on file-link detection; cleanup asks for
 * `cleanupReasoningEffortFor` instead.
 * Both dictation models default to "medium" when the field is omitted — a
 * latency/cost regression for these fast, strict-JSON tasks — so we pin the
 * lowest tier at each call site rather than inheriting the model default.
 * There is no minimum reasoning effort for strict json_schema output.
 */
export const VOICE_DICTATION_REASONING_EFFORT = "none" as const;

/** The Responses API reasoning tiers a voice-dictation request may ask for. */
export type VoiceReasoningEffort = "none" | "low" | "medium" | "high";

/** What cleanup knows of a passage when it picks the reasoning effort to send it with. */
export interface CleanupPassage {
  /** Characters in the trimmed passage. */
  chars: number;
  /** Draft text comes before it, sent as its confirmed history (`recentContext`). */
  continuing: boolean;
}

/**
 * Haiku cleans up a standalone passage shorter than this without reasoning
 * (#15504). On the cleanup benchmark (2026-10-30) those came back with a p95
 * of 1.95 s against 3.38 s at medium, and lost no ground on ready text, words
 * lost or risky trials; from 70 characters a retraction ("run it, no wait")
 * began to lose words without it.
 */
export const CLEANUP_REASONING_MIN_CHARS = 60;

/**
 * The reasoning effort cleanup, its warm-up and rewrite ask each model for,
 * chosen on the cleanup benchmark (2026-10-29). A little reasoning made every
 * model's edits safer: Haiku at medium lost a fifth of the words it lost with
 * none, and the other models gained at low, Sonnet coming back faster too.
 * Given a passage, Haiku skips it on a short standalone one, which has
 * nothing to reason over; a continuing one reads right only against what
 * went before, however short it is. Without one, the model's effort.
 */
export function cleanupReasoningEffortFor(
  model: string,
  passage?: CleanupPassage
): VoiceReasoningEffort {
  if (model !== "claude-haiku-5-5") return "low";
  return passage && !passage.continuing && passage.chars < CLEANUP_REASONING_MIN_CHARS
    ? "none"
    : "medium";
}

/**
 * Every effort a model's cleanup may send a passage with. Claude caches a
 * prompt once per thinking setting, so the warm-up primes each of them.
 */
export function cleanupWarmEffortsFor(model: string): VoiceReasoningEffort[] {
  const short = cleanupReasoningEffortFor(model, { chars: 0, continuing: false });
  return [...new Set([cleanupReasoningEffortFor(model), short])];
}

/** The longest selection a spoken rewrite takes, matching cleanup's passage cap. */
export const VOICE_REWRITE_MAX_SELECTION_CHARS = 12_000;

/** The longest spoken instruction a rewrite sends. */
export const VOICE_REWRITE_MAX_INSTRUCTION_CHARS = 2_000;

/** The most recently sent prompts a cleanup request carries. */
export const VOICE_RECENT_PROMPTS_MAX = 6;

/**
 * The longest a recent prompt runs in a cleanup request, in UTF-16 units, its
 * cut marker included: past it a pasted log or file is only its opening.
 */
export const VOICE_RECENT_PROMPT_MAX_CHARS = 1_000;

/**
 * The most draft text after a passage a cleanup request carries, in UTF-16
 * units: enough to show whether the sentence carries on, or a bracket or quote
 * already closes it.
 */
export const VOICE_FOLLOWING_TEXT_MAX_CHARS = 200;
