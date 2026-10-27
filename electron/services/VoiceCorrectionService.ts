import { createHash } from "node:crypto";
import { logDebug, logInfo, logWarn } from "../utils/logger.js";
import {
  CORE_CORRECTION_PROMPT,
  FILE_LINK_DETECTION_PROMPT,
  VOICE_DICTATION_AI_MODEL,
  VOICE_DICTATION_REASONING_EFFORT,
  buildCorrectionSystemPrompt,
  buildRewriteSystemPrompt,
  correctionInstructionsFor,
  type CorrectionInstructions,
  type CorrectionPromptContext,
  type CorrectionTargetContext,
  type CorrectionWorktreeContext,
  type VoiceReasoningEffort,
} from "../../shared/config/voiceCorrection.js";
import type { VoiceRewriteOutcome } from "../../shared/types/voice.js";
import type { VoiceCorrectionVerdict } from "../../shared/types/voiceSessionSummary.js";
import { voiceErrorLogFields } from "../../shared/utils/voiceLogFields.js";
import { buildOpenAIHeaders } from "../../shared/utils/openaiHeaders.js";
import { createTimeoutSignal, withTimeoutSignal } from "../../shared/utils/timeoutSignal.js";
import { validateRewrite } from "./voiceCorrectionGuard.js";
import {
  correctionOutcome,
  type VoiceCorrectionProposal,
  type VoiceCorrectionRejectReason,
} from "./voiceCorrectionOutcome.js";
import { mayReferenceFile } from "../../shared/utils/voiceFileLinkCommands.js";
import { sliceSpans, type VoiceTextSpan } from "../../shared/utils/voiceUncertainWords.js";
import type { HeardAsRule } from "../../shared/utils/voiceHeardAs.js";
import {
  EMPTY_VOICE_COMMAND_VOCABULARY,
  type VoiceCommandEntry,
} from "../../shared/utils/voiceAgentCommands.js";
import type { VoiceCommandTarget } from "./voiceCommandTarget.js";
import { holdsCredential, isSecretShaped } from "./voiceKeytermSecrets.js";

export { CORE_CORRECTION_PROMPT, buildCorrectionSystemPrompt };
export type { VoiceCorrectionProposal, VoiceCorrectionRejectReason };

const P = "[VoiceCorrection]";
const SHORT_CORRECTION_TIMEOUT_MS = 7000;
const LONG_CORRECTION_TIMEOUT_MS = 15000;
const LONG_CORRECTION_MIN_CHARS = 140;
const MAX_CORRECTION_TIMEOUT_MS = 60000;
const CORRECTION_TIMEOUT_MS_PER_CHAR = 5;
// Past this a passage stays raw on purpose rather than risk a cut-off reply.
const MAX_CORRECTION_INPUT_CHARS = 12000;
const MIN_OUTPUT_TOKENS = 1024;
// Room for the whole passage to come back, at up to ~1 token per character
// for CJK, plus the JSON wrapper.
const OUTPUT_TOKENS_PER_CHAR = 1.5;
const OUTPUT_TOKENS_OVERHEAD = 256;
const FILE_LINK_MAX_OUTPUT_TOKENS = 256;
const PROMPT_CACHE_PREFIX = "voice-correction-v13";
// OpenAI rejects a prompt_cache_key longer than 64 characters.
const PROMPT_CACHE_KEY_MAX_LENGTH = 64;
const FILE_LINK_DETECTION_TIMEOUT_MS = 4000;
const REWRITE_CACHE_PREFIX = "voice-rewrite-v1";
const MIN_REWRITE_TIMEOUT_MS = 10000;
const FILE_LINK_CACHE_PREFIX = "voice-file-link-v2";
const PROMPT_TAG_OPEN_RE = /<(?=\/?(?:terminal_output|target|job|confirmed_history|uncertain)\b)/gi;
const OPENAI_ORIGIN = "https://api.openai.com/";
const RESPONSES_URL = "https://api.openai.com/v1/responses";
// OpenAI keeps an unused prefix cached for five to ten minutes. Checked once a
// minute, a prompt goes out again within four of its last use.
const PROMPT_WARM_FOR_MS = 3 * 60_000;
const PROMPT_USE_MEMORY = 16;
const WARM_TIMEOUT_MS = 10_000;
// The API's floor. The reply is thrown away, cut off or not.
const WARM_MAX_OUTPUT_TOKENS = 16;
const WARM_USER_MESSAGE = "<job>\nreason=warmup\n</job>\n\n<target>\n</target>";
const PRECONNECT_TIMEOUT_MS = 3000;
const PRECONNECT_WAIT_MS = 250;
// Fetch keeps an idle socket for four seconds; one this fresh will still be
// there for a passage sent now.
const PRECONNECT_FRESH_MS = 2000;
const LEADING_FILLER_RE = /^(?:\s*(?:um|uh)[\s,.;:!-]+)+/i;
// How often a streaming correction reports its text so far: a sweep of a few
// dozen steps a second, not one per token.
const STREAM_PROGRESS_INTERVAL_MS = 33;
// The strict schema writes `action` first, so a reply that replaces the text
// says so before any of it streams.
const STREAMED_TEXT_START_RE = /^\s*\{\s*"action"\s*:\s*"replace"\s*,\s*"corrected_text"\s*:\s*"/;
const JSON_ESCAPES: Record<string, string> = {
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};
// Two flagged words with only spaces between them are one unsure phrase.
const UNCERTAIN_JOIN_RE = /^[^\S\r\n]+$/;

const FILE_LINK_DETECTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    file_references: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          description: { type: "string" },
        },
        required: ["description"],
      },
    },
  },
  required: ["file_references"],
} as const;

// Names and descriptions come from the user's own command and skill files, so
// they pass the same secret screen as every other on-disk context before they
// leave the machine.
function promptCommands(
  entries: readonly VoiceCommandEntry[]
): CorrectionTargetContext["commands"] {
  return entries.flatMap((entry) =>
    isSecretShaped(entry.token.slice(entry.prefix.length))
      ? []
      : [
          {
            token: entry.token,
            description: holdsCredential(entry.description) ? "" : entry.description,
          },
        ]
  );
}

const CORRECTION_RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: {
      type: "string",
      enum: ["no_change", "replace"],
    },
    corrected_text: {
      type: "string",
    },
    confidence: {
      type: "string",
      enum: ["low", "medium", "high"],
    },
  },
  required: ["action", "corrected_text", "confidence"],
} as const;

const REWRITE_RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: {
      type: "string",
      enum: ["no_change", "replace"],
    },
    rewritten_text: {
      type: "string",
    },
  },
  required: ["action", "rewritten_text"],
} as const;

export interface VoiceRewriteRequest {
  selectedText: string;
  instruction: string;
}

export interface VoiceCorrectionSettings {
  model: string;
  /** Overrides VOICE_DICTATION_REASONING_EFFORT for cleanup, its warm-up and rewrite. */
  reasoningEffort?: VoiceReasoningEffort;
  /** Cleanup rules in place of the model's own (`correctionInstructionsFor`): the cleanup benchmark's prompt variants. */
  instructions?: CorrectionInstructions;
  apiKey: string;
  customDictionary: string[];
  knownNames?: string[];
  /** The session's repository names, read with its keyterms; cleanup only. */
  repositoryNames?: string[];
  /** The worktree the session dictates in; cleanup only. */
  worktree?: CorrectionWorktreeContext;
  heardAs?: readonly HeardAsRule[];
  customInstructions?: string;
  language?: string;
  projectName?: string;
  projectPath?: string;
  organizationId?: string;
  projectId?: string;
  /** The agent the passage is written into and its commands; absent for no agent. */
  commandTarget?: VoiceCommandTarget;
}

export interface VoiceCorrectionRequest {
  rawText: string;
  recentContext?: string[];
  /** What the dictated terminal recently printed, redacted and bounded; evidence for what was heard, never text to correct. */
  terminalOutput?: string;
  reason?: string;
  segmentCount?: number;
  /** The words in `rawText` the recogniser was unsure of; transcript content, so never logged. */
  uncertain?: readonly VoiceTextSpan[];
  /** Nothing comes before the passage in the draft, so it may open with a command. */
  startsPrompt?: boolean;
}

export interface VoiceCorrectionResult {
  action: "no_change" | "replace";
  correctedText: string;
  confidence: "low" | "medium" | "high";
  confirmedText: string;
  /** Why the passage came back as it did, for the session summary: a code, never text. */
  verdict: VoiceCorrectionVerdict;
  /** The request failed or was cancelled, so the raw text stands untried. */
  failed?: true;
  /** The cleanup the model proposed and the check that turned it down; transcript content, so never logged. */
  rejected?: { reason: VoiceCorrectionRejectReason; candidate: string };
  /** The reply as the model gave it, before any check; absent when none parsed. Transcript content, so never logged. */
  proposal?: VoiceCorrectionProposal;
  /**
   * When the OpenAI request went out (performance.now()), how long it took,
   * and the tokens it was billed for when the reply said; absent when none went out.
   */
  roundTrip?: { sentAt: number; ms: number; usage?: VoiceCorrectionUsage };
}

/** Reasoning tokens are part of `outputTokens`, and cached ones part of `inputTokens`. */
export interface VoiceCorrectionUsage {
  inputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

interface ResponsesUsage {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  output_tokens_details?: { reasoning_tokens?: number };
}

function readUsage(usage: ResponsesUsage | undefined): VoiceCorrectionUsage | undefined {
  if (typeof usage?.input_tokens !== "number" || typeof usage.output_tokens !== "number") {
    return undefined;
  }
  return {
    inputTokens: usage.input_tokens,
    cachedTokens: usage.input_tokens_details?.cached_tokens ?? 0,
    cacheWriteTokens: usage.input_tokens_details?.cache_write_tokens ?? 0,
    outputTokens: usage.output_tokens,
    reasoningTokens: usage.output_tokens_details?.reasoning_tokens ?? 0,
  };
}

/** Filled in as a correction's one request goes out and settles. */
interface RequestTrace {
  sentAt?: number;
  settledAt?: number;
  usage?: VoiceCorrectionUsage;
}

interface CorrectionApiResult {
  action: "no_change" | "replace";
  corrected_text: string;
  confidence: "low" | "medium" | "high";
}

/** The Responses API reply, read whole or rebuilt from its stream. */
interface CorrectionReply {
  output_text?: string;
  output?: Array<{ content?: Array<{ text?: string }> }>;
  status?: string;
  incomplete_details?: { reason?: string };
  usage?: ResponsesUsage;
}

interface CorrectionStreamEvent {
  type?: string;
  delta?: string;
  output_index?: number;
  content_index?: number;
  response?: CorrectionReply & { error?: { code?: unknown } | null };
  code?: unknown;
  error?: { code?: unknown };
}

/**
 * The corrected text a partial reply has written so far, as it would land:
 * leading filler gone, and cut at its last whitespace so a word still
 * arriving isn't shown half-written. Null until a reply that replaces the
 * text has started it.
 */
function streamedCorrectionText(reply: string): string | null {
  const start = STREAMED_TEXT_START_RE.exec(reply);
  if (!start) return null;
  let text = "";
  for (let i = start[0].length; i < reply.length; i++) {
    const ch = reply[i]!;
    if (ch === '"') break;
    if (ch !== "\\") {
      text += ch;
      continue;
    }
    const escaped = reply[i + 1];
    if (escaped === undefined) break;
    if (escaped === "u") {
      const hex = reply.slice(i + 2, i + 6);
      if (!/^[0-9a-f]{4}$/i.test(hex)) break;
      text += String.fromCharCode(parseInt(hex, 16));
      i += 5;
    } else {
      text += JSON_ESCAPES[escaped] ?? escaped;
      i++;
    }
  }
  const cleaned = text.replace(LEADING_FILLER_RE, "").trimStart();
  const cut = cleaned.search(/\s\S*$/);
  return cut > 0 ? cleaned.slice(0, cut) : "";
}

/** Each complete server-sent event's JSON in `buffer`, and what's left of it. */
function takeStreamEvents(buffer: string): { events: CorrectionStreamEvent[]; rest: string } {
  const frames = buffer.split(/\r?\n\r?\n/);
  const rest = frames.pop() ?? "";
  const events: CorrectionStreamEvent[] = [];
  for (const frame of frames) {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (data) events.push(JSON.parse(data) as CorrectionStreamEvent);
  }
  return { events, rest };
}

// Carries the status and OpenAI error code only; the body's message can echo request content.
class OpenAIRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined
  ) {
    super(`OpenAI API error: ${status}${code ? ` (${code})` : ""}`);
  }

  static async fromResponse(response: Response): Promise<OpenAIRequestError> {
    let code: string | undefined;
    try {
      const body = (await response.json()) as { error?: { code?: unknown } };
      if (typeof body.error?.code === "string") code = body.error.code;
    } catch {
      // Non-JSON error body: the status alone is enough.
    }
    return new OpenAIRequestError(response.status, code);
  }
}

// A reply that is discarded whole rather than applied. Its code reaches the
// logs through voiceErrorLogFields, so a deliberate raw fallback is visible.
class CorrectionDiscardedError extends Error {
  constructor(readonly code: "incomplete" | "malformed") {
    super(`Correction reply ${code}`);
    this.name = "CorrectionDiscardedError";
  }
}

export class VoiceCorrectionService {
  // When each correction prompt last reached OpenAI, by account and content.
  private readonly promptUsedAt = new Map<string, number>();
  private readonly warming = new Set<string>();
  private preconnecting: Promise<void> | null = null;
  private preconnectedAt: number | null = null;

  /**
   * Cleans up one passage. `signal` belongs to the request alone: nothing
   * another dictation does can cancel it. With `onText`, the reply streams,
   * and `onText` hears the corrected text so far as it grows; the result is
   * still judged whole, and is the same one the reply would give unstreamed.
   */
  async correct(
    request: VoiceCorrectionRequest,
    settings: VoiceCorrectionSettings,
    signal?: AbortSignal,
    onText?: (text: string) => void
  ): Promise<VoiceCorrectionResult> {
    const trace: RequestTrace = {};
    const result = await this.correctPassage(request, settings, trace, signal, onText);
    if (trace.sentAt === undefined) return result;
    const ms = (trace.settledAt ?? performance.now()) - trace.sentAt;
    const usage = trace.usage ? { usage: trace.usage } : {};
    return { ...result, roundTrip: { sentAt: trace.sentAt, ms, ...usage } };
  }

  private async correctPassage(
    request: VoiceCorrectionRequest,
    settings: VoiceCorrectionSettings,
    trace: RequestTrace,
    signal: AbortSignal | undefined,
    onText: ((text: string) => void) | undefined
  ): Promise<VoiceCorrectionResult> {
    const trimmedRaw = request.rawText.trim();
    if (!trimmedRaw) {
      return {
        action: "no_change",
        correctedText: request.rawText,
        confidence: "high",
        confirmedText: request.rawText,
        verdict: "skipped",
      };
    }

    if (trimmedRaw.length > MAX_CORRECTION_INPUT_CHARS) {
      logInfo(`${P} Skipping correction — passage too long`, {
        rawLen: trimmedRaw.length,
        maxLen: MAX_CORRECTION_INPUT_CHARS,
      });
      return {
        action: "no_change",
        correctedText: request.rawText,
        confidence: "high",
        confirmedText: request.rawText,
        verdict: "skipped",
      };
    }

    try {
      const lead = request.rawText.length - request.rawText.trimStart().length;
      const proposal = await this.callApi(
        {
          ...request,
          rawText: trimmedRaw,
          uncertain: sliceSpans(request.uncertain ?? [], lead, lead + trimmedRaw.length),
        },
        settings,
        trace,
        signal,
        onText
      );

      const outcome = correctionOutcome(request.rawText, proposal, {
        vocabulary: settings.commandTarget?.vocabulary ?? EMPTY_VOICE_COMMAND_VOCABULARY,
        startsPrompt: request.startsPrompt === true,
      });
      if (outcome.rejected) {
        logDebug(`${P} Correction rejected, keeping raw text`, {
          reason: outcome.rejected.reason,
          rawLen: request.rawText.length,
          correctedLen: outcome.rejected.candidate.length,
        });
      } else {
        logDebug(`${P} Correction success`, {
          rawLen: request.rawText.length,
          correctedLen: outcome.confirmedText.length,
          action: outcome.action,
          confidence: proposal.confidence,
          contextLen: request.recentContext?.length ?? 0,
          reason: request.reason ?? "unspecified",
        });
      }

      return {
        action: outcome.action,
        correctedText: outcome.confirmedText,
        confidence: proposal.confidence,
        confirmedText: outcome.confirmedText,
        verdict: outcome.verdict,
        ...(outcome.rejected ? { rejected: outcome.rejected } : {}),
        proposal,
      };
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return {
          action: "no_change",
          correctedText: request.rawText,
          confidence: "low",
          confirmedText: request.rawText,
          failed: true,
          verdict: "failed",
        };
      }
      const rejection = error instanceof OpenAIRequestError ? error : undefined;
      logWarn(`${P} Correction failed, using raw text`, {
        ...voiceErrorLogFields(error),
        status: rejection?.status,
        code: rejection?.code,
      });
      return {
        action: "no_change",
        correctedText: request.rawText,
        confidence: "low",
        confirmedText: request.rawText,
        failed: true,
        verdict:
          error instanceof DOMException && error.name === "TimeoutError" ? "timed_out" : "failed",
      };
    }
  }

  private buildPromptCacheKey(settings: VoiceCorrectionSettings): string {
    const projectKey = settings.projectName ?? settings.projectPath ?? "global";
    const target = settings.commandTarget;
    const targetKey = target
      ? `${target.agentId}:${target.isAssistant ? "assistant" : "agent"}`
      : "none";
    const parts: unknown[] = [settings.model, projectKey, targetKey, settings.customDictionary];
    // Each only when there are some, so a session without names or heard-as
    // rules keeps the key its prompt has without them. Names are strings and
    // rules are objects, so they never hash alike.
    if (settings.knownNames && settings.knownNames.length > 0) parts.push(settings.knownNames);
    if (settings.heardAs && settings.heardAs.length > 0) parts.push(settings.heardAs);
    // Keyed by kind, so neither can hash alike with the lists above.
    if (settings.repositoryNames && settings.repositoryNames.length > 0) {
      parts.push({ repositoryNames: settings.repositoryNames });
    }
    if (settings.worktree) parts.push({ worktree: settings.worktree });
    if (settings.instructions) parts.push({ instructions: settings.instructions });
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(parts))
      .digest("hex")
      .slice(0, 32);
    return `${PROMPT_CACHE_PREFIX}:${fingerprint}`.slice(0, PROMPT_CACHE_KEY_MAX_LENGTH);
  }

  private extractResponseText(data: {
    output_text?: string;
    output?: Array<{ content?: Array<{ text?: string }> }>;
  }): string {
    if (typeof data.output_text === "string" && data.output_text.trim()) {
      return data.output_text;
    }

    const text = data.output?.flatMap((item) => item.content ?? []).find((item) => item.text)?.text;
    if (!text) {
      throw new Error("No content in API response");
    }
    return text;
  }

  private buildUserMessage(request: VoiceCorrectionRequest): string {
    const parts: string[] = [];

    if (request.recentContext && request.recentContext.length > 0) {
      parts.push(
        `<confirmed_history>\n${request.recentContext
          .map((sentence, index) => `${index + 1}. ${sentence}`)
          .join("\n")}\n</confirmed_history>`
      );
    }

    if (request.reason || request.segmentCount || request.startsPrompt !== undefined) {
      const metadata: string[] = [];
      if (request.reason) {
        metadata.push(`reason=${request.reason}`);
      }
      if (request.segmentCount) {
        metadata.push(`segments=${request.segmentCount}`);
      }
      if (request.startsPrompt !== undefined) {
        metadata.push(`prompt_start=${request.startsPrompt ? "yes" : "no"}`);
      }
      parts.push(`<job>\n${metadata.join("\n")}\n</job>`);
    }

    const targetText = VoiceCorrectionService.annotateUncertainSpans(
      request.rawText,
      request.uncertain ?? []
    );
    parts.push(`<target>\n${targetText}\n</target>`);

    if (request.terminalOutput?.trim()) {
      // Output the terminal printed must not be able to close its own block or
      // open a <target> of its own.
      const output = request.terminalOutput.trim().replace(PROMPT_TAG_OPEN_RE, "‹");
      parts.push(`<terminal_output>\n${output}\n</terminal_output>`);
    }

    return parts.join("\n\n");
  }

  /**
   * Wraps each span of `text` in <uncertain>, by position, so only the words
   * flagged are tagged even where the same word appears again. Words flagged
   * side by side, with only spaces between, share one tag. A span out of
   * bounds, overlapping an earlier one, or holding no word is ignored.
   */
  static annotateUncertainSpans(text: string, spans: readonly VoiceTextSpan[]): string {
    const tags: VoiceTextSpan[] = [];
    for (const span of [...spans].sort((a, b) => a.from - b.from)) {
      const { from, to } = span;
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to > text.length) {
        continue;
      }
      if (from >= to || !text.slice(from, to).trim()) continue;
      const last = tags[tags.length - 1];
      if (last && from < last.to) continue;
      if (last && UNCERTAIN_JOIN_RE.test(text.slice(last.to, from))) last.to = to;
      else tags.push({ from, to });
    }
    let out = "";
    let copied = 0;
    for (const { from, to } of tags) {
      out += `${text.slice(copied, from)}<uncertain>${text.slice(from, to)}</uncertain>`;
      copied = to;
    }
    return out + text.slice(copied);
  }

  /**
   * Applies a spoken instruction to selected composer text, under its own
   * deadline: the recording that captured the instruction has ended by the
   * time this runs, and a new one starting must not cancel it.
   */
  async rewrite(
    request: VoiceRewriteRequest,
    settings: VoiceCorrectionSettings
  ): Promise<VoiceRewriteOutcome> {
    const selectedText = request.selectedText;
    const instruction = request.instruction.trim();
    if (!settings.apiKey) return { status: "unavailable" };
    if (!selectedText.trim() || !instruction) return { status: "no_change" };

    const maxOutputTokens = this.getMaxOutputTokens({ rawText: selectedText });
    const timeoutMs = Math.max(
      MIN_REWRITE_TIMEOUT_MS,
      this.getCorrectionTimeoutMs({ rawText: selectedText, segmentCount: 2 })
    );
    const deadline = createTimeoutSignal(timeoutMs);
    const startedAt = performance.now();
    try {
      const response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...buildOpenAIHeaders(settings.apiKey, settings.organizationId, settings.projectId),
        },
        signal: deadline.signal,
        body: JSON.stringify({
          model: settings.model,
          input: [
            {
              role: "developer",
              content: buildRewriteSystemPrompt({ language: settings.language }),
            },
            {
              role: "user",
              content: `<selection>\n${selectedText}\n</selection>\n\n<instruction>\n${instruction}\n</instruction>`,
            },
          ],
          prompt_cache_key: REWRITE_CACHE_PREFIX,
          service_tier: "auto",
          reasoning: { effort: settings.reasoningEffort ?? VOICE_DICTATION_REASONING_EFFORT },
          text: {
            format: {
              type: "json_schema",
              name: "voice_rewrite_result",
              strict: true,
              schema: REWRITE_RESULT_SCHEMA,
            },
          },
          max_output_tokens: maxOutputTokens,
        }),
      });
      if (!response.ok) throw await OpenAIRequestError.fromResponse(response);

      const data = (await response.json()) as {
        output_text?: string;
        output?: Array<{ content?: Array<{ text?: string }> }>;
        status?: string;
      };
      if (data.status === "incomplete") throw new CorrectionDiscardedError("incomplete");
      const parsed = JSON.parse(this.extractResponseText(data)) as {
        action?: unknown;
        rewritten_text?: unknown;
      };
      if (
        (parsed.action !== "no_change" && parsed.action !== "replace") ||
        typeof parsed.rewritten_text !== "string"
      ) {
        throw new CorrectionDiscardedError("malformed");
      }

      const rewritten = parsed.rewritten_text.trim();
      let outcome: VoiceRewriteOutcome;
      if (parsed.action === "no_change" || !rewritten || rewritten === selectedText.trim()) {
        outcome = { status: "no_change" };
      } else if (!validateRewrite(selectedText, rewritten).ok) {
        outcome = { status: "rejected" };
      } else {
        // The selection's own edge whitespace stays, so a rewrite never
        // glues itself to the words either side.
        const lead = /^\s*/u.exec(selectedText)?.[0] ?? "";
        const trail = /\s*$/u.exec(selectedText.slice(lead.length))?.[0] ?? "";
        outcome = { status: "replace", text: lead + rewritten + trail };
      }
      logDebug(`${P} Rewrite settled`, {
        status: outcome.status,
        selectionLen: selectedText.length,
        instructionLen: instruction.length,
        rewrittenLen: rewritten.length,
        elapsedMs: Math.round(performance.now() - startedAt),
      });
      return outcome;
    } catch (error) {
      const rejection = error instanceof OpenAIRequestError ? error : undefined;
      logWarn(`${P} Rewrite failed, keeping the selection`, {
        ...voiceErrorLogFields(error),
        status: rejection?.status,
        code: rejection?.code,
        elapsedMs: Math.round(performance.now() - startedAt),
      });
      return { status: "failed" };
    } finally {
      deadline.dispose();
    }
  }

  async detectFileLinkTokens(
    utterance: string,
    settings: Pick<VoiceCorrectionSettings, "apiKey" | "organizationId" | "projectId">,
    signal?: AbortSignal
  ): Promise<Array<{ description: string }>> {
    const trimmed = utterance.trim();
    if (!trimmed) return [];
    if (!mayReferenceFile(trimmed)) return [];

    const deadline = createTimeoutSignal(FILE_LINK_DETECTION_TIMEOUT_MS, signal);
    try {
      const response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...buildOpenAIHeaders(settings.apiKey, settings.organizationId, settings.projectId),
        },
        signal: deadline.signal,
        body: JSON.stringify({
          model: VOICE_DICTATION_AI_MODEL,
          instructions: FILE_LINK_DETECTION_PROMPT,
          input: trimmed,
          prompt_cache_key: FILE_LINK_CACHE_PREFIX,
          service_tier: "auto",
          reasoning: { effort: VOICE_DICTATION_REASONING_EFFORT },
          text: {
            format: {
              type: "json_schema",
              name: "voice_file_link_detection",
              strict: true,
              schema: FILE_LINK_DETECTION_SCHEMA,
            },
          },
          max_output_tokens: FILE_LINK_MAX_OUTPUT_TOKENS,
        }),
      });

      if (!response.ok) {
        const failure = await OpenAIRequestError.fromResponse(response);
        logWarn(`${P} File link detection API error: ${response.status}`, { code: failure.code });
        return [];
      }

      const data = (await response.json()) as {
        output_text?: string;
        output?: Array<{ content?: Array<{ text?: string }> }>;
        status?: string;
        incomplete_details?: { reason?: string };
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
          input_tokens_details?: { cached_tokens?: number };
        };
      };

      if (data.status === "incomplete") {
        logWarn(`${P} File link detection truncated`, {
          reason: data.incomplete_details?.reason ?? "unknown",
          maxOutputTokens: FILE_LINK_MAX_OUTPUT_TOKENS,
          utteranceLen: trimmed.length,
        });
        return [];
      }

      const parsed = JSON.parse(this.extractResponseText(data)) as {
        file_references: Array<{ description: string }>;
      };

      logDebug(`${P} File link detection success`, {
        count: parsed.file_references.length,
        cachedTokens: data.usage?.input_tokens_details?.cached_tokens ?? 0,
        inputTokens: data.usage?.input_tokens,
        outputTokens: data.usage?.output_tokens,
      });

      return parsed.file_references.filter((r) => r.description.trim().length > 0);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return [];
      logWarn(`${P} File link detection failed`, voiceErrorLogFields(error));
      return [];
    } finally {
      deadline.dispose();
    }
  }

  private getCorrectionTimeoutMs(
    request: Pick<VoiceCorrectionRequest, "rawText" | "segmentCount">
  ): number {
    const length = request.rawText.length;
    if (length < LONG_CORRECTION_MIN_CHARS && (request.segmentCount ?? 0) <= 1) {
      return SHORT_CORRECTION_TIMEOUT_MS;
    }
    const extraChars = Math.max(0, length - 1000);
    return Math.min(
      MAX_CORRECTION_TIMEOUT_MS,
      LONG_CORRECTION_TIMEOUT_MS + extraChars * CORRECTION_TIMEOUT_MS_PER_CHAR
    );
  }

  private getMaxOutputTokens(request: Pick<VoiceCorrectionRequest, "rawText">): number {
    return Math.max(
      MIN_OUTPUT_TOKENS,
      Math.ceil(request.rawText.length * OUTPUT_TOKENS_PER_CHAR) + OUTPUT_TOKENS_OVERHEAD
    );
  }

  private normalizeCorrectedText(text: string): string {
    return text.replace(LEADING_FILLER_RE, "");
  }

  private async callApi(
    request: VoiceCorrectionRequest,
    settings: VoiceCorrectionSettings,
    trace: RequestTrace,
    signal: AbortSignal | undefined,
    onText: ((text: string) => void) | undefined
  ): Promise<VoiceCorrectionProposal> {
    const systemPrompt = this.buildSystemPrompt(settings);
    const userMessage = this.buildUserMessage(request);
    logDebug(`${P} Calling Responses API`, {
      model: settings.model,
      contextLen: request.recentContext?.length ?? 0,
      terminalOutputLen: request.terminalOutput?.length ?? 0,
      uncertainCount: request.uncertain?.length ?? 0,
      reason: request.reason ?? "unspecified",
      segmentCount: request.segmentCount ?? 0,
    });

    return await withTimeoutSignal(
      this.getCorrectionTimeoutMs(request),
      (deadline) =>
        this.requestCorrection(
          request,
          settings,
          systemPrompt,
          userMessage,
          deadline,
          trace,
          onText
        ),
      signal
    );
  }

  private buildSystemPrompt(settings: VoiceCorrectionSettings): string {
    const {
      customDictionary,
      knownNames,
      repositoryNames,
      worktree,
      heardAs,
      customInstructions,
      projectName,
      projectPath,
      language,
    } = settings;

    const target = settings.commandTarget;
    const context: CorrectionPromptContext = {
      ...(target
        ? {
            target: {
              agentName: target.agentName,
              isAssistant: target.isAssistant,
              commands: promptCommands(target.vocabulary.entries),
            },
          }
        : {}),
      projectName,
      projectPath,
      customDictionary,
      knownNames,
      repositoryNames,
      worktree,
      heardAs,
      customInstructions,
      language,
    };
    return buildCorrectionSystemPrompt(
      context,
      settings.instructions ?? correctionInstructionsFor(settings.model)
    );
  }

  // The warm-up shares everything but the user turn and the output cap, so
  // the prefix it leaves in the cache is the one the passage arrives with.
  private correctionBody(
    settings: VoiceCorrectionSettings,
    systemPrompt: string,
    userMessage: string,
    maxOutputTokens: number
  ) {
    return {
      model: settings.model,
      // Pass the system prompt as the first developer message in the `input`
      // array (not the top-level `instructions` field) so its stable prefix is
      // eligible for OpenAI prompt caching. See issue #9746.
      input: [
        { role: "developer", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      prompt_cache_key: this.buildPromptCacheKey(settings),
      service_tier: "auto",
      // Explicit low-latency effort: the dictation models default to "medium"
      // when omitted, so we pin the lowest tier rather than inherit that default.
      reasoning: { effort: settings.reasoningEffort ?? VOICE_DICTATION_REASONING_EFFORT },
      text: {
        format: {
          type: "json_schema",
          name: "voice_correction_result",
          strict: true,
          schema: CORRECTION_RESULT_SCHEMA,
        },
      },
      max_output_tokens: maxOutputTokens,
    };
  }

  // Caches are per account, and the cache key leaves out parts of the prompt.
  private promptIdentity(settings: VoiceCorrectionSettings, systemPrompt: string): string {
    return createHash("sha256")
      .update(
        JSON.stringify([
          settings.apiKey,
          settings.organizationId ?? null,
          settings.projectId ?? null,
          settings.model,
          this.buildPromptCacheKey(settings),
          systemPrompt,
        ])
      )
      .digest("hex");
  }

  // Stamped when the request went out: OpenAI caches the prefix as it reads it.
  private notePromptUsed(identity: string, sentAt: number): void {
    this.promptUsedAt.delete(identity);
    this.promptUsedAt.set(identity, sentAt);
    for (const oldest of this.promptUsedAt.keys()) {
      if (this.promptUsedAt.size <= PROMPT_USE_MEMORY) break;
      this.promptUsedAt.delete(oldest);
    }
  }

  /**
   * Sends the correction's developer message ahead of any passage, so the
   * prompt cache holds it when one arrives. The user turn is a fixed
   * placeholder: nothing dictated, drafted or read from a terminal goes with
   * it. A prompt that went out in the last few minutes is left alone.
   */
  async warm(settings: VoiceCorrectionSettings): Promise<void> {
    const systemPrompt = this.buildSystemPrompt(settings);
    const identity = this.promptIdentity(settings, systemPrompt);
    const usedAt = this.promptUsedAt.get(identity);
    if (usedAt !== undefined && performance.now() - usedAt < PROMPT_WARM_FOR_MS) return;
    if (this.warming.has(identity)) return;
    this.warming.add(identity);
    // Its own deadline: a session ending mustn't abort it, which would throw
    // away the socket it opened.
    const deadline = createTimeoutSignal(WARM_TIMEOUT_MS);
    const sentAt = performance.now();
    try {
      const response = await fetch(RESPONSES_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...buildOpenAIHeaders(settings.apiKey, settings.organizationId, settings.projectId),
        },
        signal: deadline.signal,
        body: JSON.stringify({
          ...this.correctionBody(settings, systemPrompt, WARM_USER_MESSAGE, WARM_MAX_OUTPUT_TOKENS),
          store: false,
        }),
      });
      // Read to the end, so the socket goes back to the pool.
      await response.arrayBuffer();
      if (response.ok) this.notePromptUsed(identity, sentAt);
      logDebug(`${P} Prompt warm-up`, { status: response.status });
    } catch (error) {
      logDebug(`${P} Prompt warm-up failed`, voiceErrorLogFields(error));
    } finally {
      deadline.dispose();
      this.warming.delete(identity);
    }
  }

  /**
   * Opens a socket to OpenAI while a stop drains, for the correction that
   * follows. Fetch closes an idle socket after a few seconds, so after any
   * real dictation the correction would otherwise start with a handshake.
   * The request carries no credentials and no text; the edge answers it.
   */
  preconnect(): void {
    if (this.preconnecting) return;
    const openedAt = this.preconnectedAt;
    if (openedAt !== null && performance.now() - openedAt < PRECONNECT_FRESH_MS) return;
    const deadline = createTimeoutSignal(PRECONNECT_TIMEOUT_MS);
    const probe: Promise<void> = fetch(OPENAI_ORIGIN, {
      redirect: "manual",
      signal: deadline.signal,
    })
      .then((response) => response.arrayBuffer())
      .then(
        () => {
          this.preconnectedAt = performance.now();
        },
        () => undefined
      )
      .finally(() => {
        deadline.dispose();
        if (this.preconnecting === probe) this.preconnecting = null;
      });
    this.preconnecting = probe;
  }

  // A probe still opening its socket is nearer done than a new handshake, and
  // with one request per socket, going ahead without it would start another.
  private async awaitPreconnect(probe: Promise<void>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        probe,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, PRECONNECT_WAIT_MS);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async requestCorrection(
    request: VoiceCorrectionRequest,
    settings: VoiceCorrectionSettings,
    systemPrompt: string,
    userMessage: string,
    signal: AbortSignal,
    trace: RequestTrace,
    onText: ((text: string) => void) | undefined
  ): Promise<VoiceCorrectionProposal> {
    const maxOutputTokens = this.getMaxOutputTokens(request);
    const body = JSON.stringify({
      ...this.correctionBody(settings, systemPrompt, userMessage, maxOutputTokens),
      ...(onText ? { stream: true } : {}),
    });
    if (this.preconnecting) {
      await this.awaitPreconnect(this.preconnecting);
      // Nothing went out, so there is no round trip to report.
      signal.throwIfAborted();
    }
    const sentAt = performance.now();
    trace.sentAt = sentAt;
    try {
      const result = await this.sendCorrection(
        request,
        settings,
        body,
        signal,
        maxOutputTokens,
        onText,
        trace
      );
      this.notePromptUsed(this.promptIdentity(settings, systemPrompt), sentAt);
      return result;
    } finally {
      trace.settledAt = performance.now();
    }
  }

  private async sendCorrection(
    request: VoiceCorrectionRequest,
    settings: VoiceCorrectionSettings,
    body: string,
    signal: AbortSignal,
    maxOutputTokens: number,
    onText: ((text: string) => void) | undefined,
    trace: RequestTrace
  ): Promise<VoiceCorrectionProposal> {
    const response = await fetch(RESPONSES_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...buildOpenAIHeaders(settings.apiKey, settings.organizationId, settings.projectId),
      },
      signal,
      body,
    });

    if (!response.ok) {
      throw await OpenAIRequestError.fromResponse(response);
    }

    const data = onText
      ? await this.readCorrectionStream(response, onText)
      : ((await response.json()) as CorrectionReply);
    // A reply thrown away below was still billed.
    trace.usage = readUsage(data.usage);
    // A cut-off reply can still parse, so check the status before the body:
    // the passage is corrected whole or not at all.
    if (data.status === "incomplete") {
      logDebug(`${P} Correction reply cut off`, {
        reason: data.incomplete_details?.reason ?? "unknown",
        maxOutputTokens,
        rawLen: request.rawText.length,
      });
      throw new CorrectionDiscardedError("incomplete");
    }

    const parsed = JSON.parse(this.extractResponseText(data)) as CorrectionApiResult;
    if (
      (parsed.action !== "no_change" && parsed.action !== "replace") ||
      typeof parsed.corrected_text !== "string" ||
      !["low", "medium", "high"].includes(parsed.confidence)
    ) {
      throw new CorrectionDiscardedError("malformed");
    }

    logDebug(`${P} Correction API usage`, {
      cachedTokens: data.usage?.input_tokens_details?.cached_tokens ?? 0,
      inputTokens: data.usage?.input_tokens,
      outputTokens: data.usage?.output_tokens,
    });

    return {
      action: parsed.action,
      correctedText:
        parsed.action === "no_change"
          ? request.rawText
          : this.normalizeCorrectedText(parsed.corrected_text),
      confidence: parsed.confidence,
    };
  }

  /**
   * Reads a streamed reply to its end and rebuilds the reply the request
   * would have returned whole, with the text its deltas wrote. Meanwhile
   * `onText` hears the corrected text so far, once it has grown and at most
   * every STREAM_PROGRESS_INTERVAL_MS. A stream that ends before its last
   * event is a cut-off reply.
   */
  private async readCorrectionStream(
    response: Response,
    onText: (text: string) => void
  ): Promise<CorrectionReply> {
    const reader = response.body?.getReader();
    if (!reader) throw new CorrectionDiscardedError("malformed");
    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";
    // The first text part only, as a whole reply is read.
    let part: string | null = null;
    let reply: CorrectionReply | null = null;
    let reported = "";
    let reportedAt = -Infinity;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const { events, rest } = takeStreamEvents(done ? `${buffer}\n\n` : buffer);
        buffer = rest;
        for (const event of events) {
          if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
            const at = `${event.output_index ?? 0}:${event.content_index ?? 0}`;
            part ??= at;
            if (at === part) text += event.delta;
          } else if (event.type === "response.completed" || event.type === "response.incomplete") {
            reply = event.response ?? {};
          } else if (event.type === "response.failed" || event.type === "error") {
            const code = event.response?.error?.code ?? event.error?.code ?? event.code;
            throw new OpenAIRequestError(
              response.status,
              typeof code === "string" ? code : undefined
            );
          }
        }
        if (done) break;
        const now = performance.now();
        if (reply === null && now - reportedAt >= STREAM_PROGRESS_INTERVAL_MS) {
          const shown = streamedCorrectionText(text);
          if (shown && shown.length > reported.length) {
            reported = shown;
            reportedAt = now;
            onText(shown);
          }
        }
      }
    } catch (error) {
      void reader.cancel().catch(() => undefined);
      throw error;
    }
    if (reply === null) throw new CorrectionDiscardedError("incomplete");
    return text ? { ...reply, output_text: text } : reply;
  }
}
