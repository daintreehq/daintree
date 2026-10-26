import { createHash } from "node:crypto";
import { logDebug, logInfo, logWarn } from "../utils/logger.js";
import {
  CORE_CORRECTION_PROMPT,
  CONFIDENCE_SKIP_THRESHOLD,
  FILE_LINK_DETECTION_PROMPT,
  VOICE_DICTATION_AI_MODEL,
  VOICE_DICTATION_REASONING_EFFORT,
  buildCorrectionSystemPrompt,
  type CorrectionPromptContext,
} from "../../shared/config/voiceCorrection.js";
import { voiceErrorLogFields } from "../../shared/utils/voiceLogFields.js";
import { buildOpenAIHeaders } from "../../shared/utils/openaiHeaders.js";
import { createTimeoutSignal, withTimeoutSignal } from "../../shared/utils/timeoutSignal.js";
import {
  findProtectedRanges,
  validateCorrection,
  type CorrectionRejectReason,
} from "./voiceCorrectionGuard.js";
import { mayReferenceFile } from "../../shared/utils/voiceFileLinkCommands.js";

export { CORE_CORRECTION_PROMPT, buildCorrectionSystemPrompt };

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
const PROMPT_CACHE_PREFIX = "voice-correction-v9";
// OpenAI rejects a prompt_cache_key longer than 64 characters.
const PROMPT_CACHE_KEY_MAX_LENGTH = 64;
const FILE_LINK_DETECTION_TIMEOUT_MS = 4000;
const FILE_LINK_CACHE_PREFIX = "voice-file-link-v2";
const LEADING_FILLER_RE = /^(?:\s*(?:um|uh)[\s,.;:!-]+)+/i;
const DICTIONARY_TERM_BOUNDARY_RE = /[\p{L}\p{N}_]/u;

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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

export interface VoiceCorrectionSettings {
  model: string;
  apiKey: string;
  customDictionary: string[];
  knownNames?: string[];
  customInstructions?: string;
  language?: string;
  projectName?: string;
  projectPath?: string;
  organizationId?: string;
  projectId?: string;
}

export interface VoiceCorrectionRequest {
  rawText: string;
  recentContext?: string[];
  rightContext?: string;
  reason?: string;
  segmentCount?: number;
  uncertainWords?: string[];
  minConfidence?: number;
  wordCount?: number;
}

export interface VoiceCorrectionResult {
  action: "no_change" | "replace";
  correctedText: string;
  confidence: "low" | "medium" | "high";
  confirmedText: string;
}

interface CorrectionApiResult {
  action: "no_change" | "replace";
  corrected_text: string;
  confidence: "low" | "medium" | "high";
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
  private sessionSignal: AbortSignal | null = null;

  setSessionSignal(signal: AbortSignal | null): void {
    this.sessionSignal = signal;
  }

  async correct(
    request: VoiceCorrectionRequest,
    settings: VoiceCorrectionSettings
  ): Promise<VoiceCorrectionResult> {
    const trimmedRaw = request.rawText.trim();
    if (!trimmedRaw) {
      return {
        action: "no_change",
        correctedText: request.rawText,
        confidence: "high",
        confirmedText: request.rawText,
      };
    }

    if (
      request.uncertainWords !== undefined &&
      request.uncertainWords.length === 0 &&
      (request.minConfidence ?? 0) > CONFIDENCE_SKIP_THRESHOLD &&
      (request.wordCount ?? 0) > 0
    ) {
      logDebug(`${P} Skipping correction — all words high confidence`, {
        minConfidence: request.minConfidence,
        rawLen: trimmedRaw.length,
      });
      return {
        action: "no_change",
        correctedText: request.rawText,
        confidence: "high",
        confirmedText: request.rawText,
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
      };
    }

    try {
      const result = await this.callApi(
        {
          ...request,
          rawText: trimmedRaw,
        },
        settings
      );

      let confirmedText: string;
      if (result.action === "no_change" || !result.correctedText.trim()) {
        confirmedText = this.canonicalizeCustomDictionaryTerms(
          request.rawText,
          settings.customDictionary
        );
      } else {
        const candidate = this.canonicalizeCustomDictionaryTerms(
          result.correctedText.trim(),
          settings.customDictionary
        );
        const rejection = this.findRejection(request.rawText, candidate, result.confidence);
        if (rejection) {
          logDebug(`${P} Correction rejected, keeping raw text`, {
            reason: rejection,
            rawLen: request.rawText.length,
            correctedLen: candidate.length,
          });
          return {
            action: "no_change",
            correctedText: request.rawText,
            confidence: result.confidence,
            confirmedText: request.rawText,
          };
        }
        confirmedText = candidate;
      }
      const action = confirmedText === request.rawText ? "no_change" : "replace";

      logDebug(`${P} Correction success`, {
        rawLen: request.rawText.length,
        correctedLen: confirmedText.length,
        action,
        confidence: result.confidence,
        contextLen: request.recentContext?.length ?? 0,
        reason: request.reason ?? "unspecified",
      });

      return {
        ...result,
        action,
        correctedText: confirmedText,
        confirmedText,
      };
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return {
          action: "no_change",
          correctedText: request.rawText,
          confidence: "low",
          confirmedText: request.rawText,
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
      };
    }
  }

  private findRejection(
    rawText: string,
    candidate: string,
    confidence: VoiceCorrectionResult["confidence"]
  ): CorrectionRejectReason | "low_confidence" | null {
    if (confidence === "low") return "low_confidence";
    const verdict = validateCorrection(rawText, candidate);
    return verdict.ok ? null : verdict.reason;
  }

  private buildPromptCacheKey(settings: VoiceCorrectionSettings): string {
    const projectKey = settings.projectName ?? settings.projectPath ?? "global";
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify([
          settings.model,
          projectKey,
          settings.customDictionary,
          settings.knownNames ?? [],
        ])
      )
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

    if (request.reason || request.segmentCount) {
      const metadata: string[] = [];
      if (request.reason) {
        metadata.push(`reason=${request.reason}`);
      }
      if (request.segmentCount) {
        metadata.push(`segments=${request.segmentCount}`);
      }
      parts.push(`<job>\n${metadata.join("\n")}\n</job>`);
    }

    const targetText =
      request.uncertainWords && request.uncertainWords.length > 0
        ? VoiceCorrectionService.annotateUncertainWords(request.rawText, request.uncertainWords)
        : request.rawText;
    parts.push(`<target>\n${targetText}\n</target>`);

    if (request.rightContext?.trim()) {
      parts.push(`<right_context>\n${request.rightContext.trim()}\n</right_context>`);
    }

    return parts.join("\n\n");
  }

  static annotateUncertainWords(text: string, uncertainWords: string[]): string {
    if (uncertainWords.length === 0) return text;
    const queue = [...uncertainWords];
    return text.replace(/\S+/g, (token) => {
      if (queue.length === 0) return token;
      const stripped = token.replace(/^[^\w]+|[^\w]+$/g, "");
      if (stripped.toLowerCase() === queue[0].toLowerCase()) {
        queue.shift();
        return token.replace(stripped, `<uncertain>${stripped}</uncertain>`);
      }
      return token;
    });
  }

  /**
   * Takes its own abort signal rather than the session's: the final
   * utterance's detection is still running when a graceful stop ends the
   * session, and its result is still wanted.
   */
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

  private getCorrectionTimeoutMs(request: VoiceCorrectionRequest): number {
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

  private getMaxOutputTokens(request: VoiceCorrectionRequest): number {
    return Math.max(
      MIN_OUTPUT_TOKENS,
      Math.ceil(request.rawText.length * OUTPUT_TOKENS_PER_CHAR) + OUTPUT_TOKENS_OVERHEAD
    );
  }

  private normalizeCorrectedText(text: string): string {
    return text.replace(LEADING_FILLER_RE, "");
  }

  private canonicalizeCustomDictionaryTerms(text: string, customDictionary: string[]): string {
    let canonicalized = text;
    for (const term of customDictionary) {
      const canonical = term.trim();
      if (!canonical) continue;

      // Recasing never reaches into a path, flag, reference or backticked span.
      const protectedRanges = findProtectedRanges(canonicalized);
      const pattern = new RegExp(escapeRegExp(canonical), "giu");
      canonicalized = canonicalized.replace(pattern, (match, offset: number, fullText: string) => {
        const before = offset > 0 ? fullText[offset - 1] : "";
        const afterIndex = offset + match.length;
        const after = afterIndex < fullText.length ? fullText[afterIndex] : "";
        if (DICTIONARY_TERM_BOUNDARY_RE.test(before) || DICTIONARY_TERM_BOUNDARY_RE.test(after)) {
          return match;
        }
        if (protectedRanges.some((range) => offset < range.end && afterIndex > range.start)) {
          return match;
        }
        return canonical;
      });
    }
    return canonicalized;
  }

  private async callApi(
    request: VoiceCorrectionRequest,
    settings: VoiceCorrectionSettings
  ): Promise<Omit<VoiceCorrectionResult, "confirmedText">> {
    const {
      model,
      customDictionary,
      knownNames,
      customInstructions,
      projectName,
      projectPath,
      language,
    } = settings;

    const context: CorrectionPromptContext = {
      projectName,
      projectPath,
      customDictionary,
      knownNames,
      customInstructions,
      language,
    };
    const systemPrompt = buildCorrectionSystemPrompt(context);
    const userMessage = this.buildUserMessage(request);
    logDebug(`${P} Calling Responses API`, {
      model,
      contextLen: request.recentContext?.length ?? 0,
      reason: request.reason ?? "unspecified",
      segmentCount: request.segmentCount ?? 0,
    });

    return await withTimeoutSignal(
      this.getCorrectionTimeoutMs(request),
      (signal) =>
        this.requestCorrection(request, settings, model, systemPrompt, userMessage, signal),
      this.sessionSignal
    );
  }

  private async requestCorrection(
    request: VoiceCorrectionRequest,
    settings: VoiceCorrectionSettings,
    model: string,
    systemPrompt: string,
    userMessage: string,
    signal: AbortSignal
  ): Promise<Omit<VoiceCorrectionResult, "confirmedText">> {
    const maxOutputTokens = this.getMaxOutputTokens(request);
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...buildOpenAIHeaders(settings.apiKey, settings.organizationId, settings.projectId),
      },
      signal,
      body: JSON.stringify({
        model,
        // Pass the system prompt as the first developer message in the `input`
        // array (not the top-level `instructions` field) so its stable prefix is
        // eligible for OpenAI prompt caching. See issue #9746.
        input: [
          { role: "developer", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
        prompt_cache_key: this.buildPromptCacheKey(settings),
        service_tier: "auto",
        // Explicit low-latency effort: gpt-6-luna defaults to "medium" when
        // omitted, so we pin the lowest tier rather than inherit that default.
        reasoning: { effort: VOICE_DICTATION_REASONING_EFFORT },
        text: {
          format: {
            type: "json_schema",
            name: "voice_correction_result",
            strict: true,
            schema: CORRECTION_RESULT_SCHEMA,
          },
        },
        max_output_tokens: maxOutputTokens,
      }),
    });

    if (!response.ok) {
      throw await OpenAIRequestError.fromResponse(response);
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
}
