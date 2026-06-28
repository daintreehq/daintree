import { logDebug, logWarn } from "../utils/logger.js";
import {
  CORE_CORRECTION_PROMPT,
  CONFIDENCE_SKIP_THRESHOLD,
  FILE_LINK_DETECTION_PROMPT,
  buildCorrectionSystemPrompt,
  type CorrectionPromptContext,
} from "../../shared/config/voiceCorrection.js";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";
import { buildOpenAIHeaders } from "../../shared/utils/openaiHeaders.js";

export { CORE_CORRECTION_PROMPT, buildCorrectionSystemPrompt };

const P = "[VoiceCorrection]";
const SHORT_CORRECTION_TIMEOUT_MS = 7000;
const LONG_CORRECTION_TIMEOUT_MS = 15000;
const LONG_CORRECTION_MIN_CHARS = 140;
const MAX_OUTPUT_TOKENS = 1024;
const FILE_LINK_MAX_OUTPUT_TOKENS = 256;
const PROMPT_CACHE_PREFIX = "voice-correction-v7";
const FILE_LINK_DETECTION_MODEL = "gpt-5-nano";
const FILE_LINK_DETECTION_TIMEOUT_MS = 4000;
const FILE_LINK_CACHE_PREFIX = "voice-file-link-v1";
const LEADING_FILLER_RE = /^(?:\s*(?:um|uh)[\s,.;:!-]+)+/i;
const DICTIONARY_TERM_BOUNDARY_RE = /[\p{L}\p{N}_]/u;

// Permissive pre-filter — biased toward false positives so legitimate file references
// always reach the LLM. False positives cost a skipped LLM call; false negatives silently
// drop the user's intent. The "at X file/component" branch allows up to 5 words between
// "at" and the trigger noun (with hyphens) to cover natural phrasings like
// "at the input bar component" and "at sign-in component".
const FILE_LINK_TRIGGER_RE =
  /\b(?:link\s+to|at\s+file|reference|add\s+file|insert\s+file|open|at\s+(?:[\w-]+\s+){1,5}(?:file|component))\b/i;

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
  customInstructions?: string;
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

    try {
      const result = await this.callApi(
        {
          ...request,
          rawText: trimmedRaw,
        },
        settings
      );

      const apiConfirmedText =
        result.action === "no_change"
          ? request.rawText
          : result.correctedText.trim() || request.rawText;
      const confirmedText = this.canonicalizeCustomDictionaryTerms(
        apiConfirmedText,
        settings.customDictionary
      );
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
      const msg = formatErrorMessage(error, "Voice correction failed");
      logWarn(`${P} Correction failed, using raw text`, { error: msg });
      return {
        action: "no_change",
        correctedText: request.rawText,
        confidence: "low",
        confirmedText: request.rawText,
      };
    }
  }

  private buildPromptCacheKey(settings: VoiceCorrectionSettings): string {
    const projectKey = settings.projectName ?? settings.projectPath ?? "global";
    const dictionaryKey =
      settings.customDictionary.length > 0 ? settings.customDictionary.join("|") : "no-dict";
    return `${PROMPT_CACHE_PREFIX}:${settings.model}:${projectKey}:${dictionaryKey}`;
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

  async detectFileLinkTokens(
    utterance: string,
    settings: Pick<VoiceCorrectionSettings, "apiKey" | "organizationId" | "projectId">
  ): Promise<Array<{ description: string }>> {
    const trimmed = utterance.trim();
    if (!trimmed) return [];
    if (!FILE_LINK_TRIGGER_RE.test(trimmed)) return [];

    try {
      const response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...buildOpenAIHeaders(settings.apiKey, settings.organizationId, settings.projectId),
        },
        signal: this.buildFetchSignal(FILE_LINK_DETECTION_TIMEOUT_MS),
        body: JSON.stringify({
          model: FILE_LINK_DETECTION_MODEL,
          instructions: FILE_LINK_DETECTION_PROMPT,
          input: trimmed,
          prompt_cache_key: FILE_LINK_CACHE_PREFIX,
          service_tier: "auto",
          reasoning: { effort: "minimal" },
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
        logWarn(`${P} File link detection API error: ${response.status}`);
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
      const msg = formatErrorMessage(error, "Voice file link detection failed");
      logWarn(`${P} File link detection failed`, { error: msg });
      return [];
    }
  }

  private buildFetchSignal(timeoutMs: number): AbortSignal {
    if (this.sessionSignal) {
      return AbortSignal.any([this.sessionSignal, AbortSignal.timeout(timeoutMs)]);
    }
    return AbortSignal.timeout(timeoutMs);
  }

  private getCorrectionTimeoutMs(request: VoiceCorrectionRequest): number {
    if (request.rawText.length >= LONG_CORRECTION_MIN_CHARS || (request.segmentCount ?? 0) > 1) {
      return LONG_CORRECTION_TIMEOUT_MS;
    }
    return SHORT_CORRECTION_TIMEOUT_MS;
  }

  private getReasoningConfig(model: string): { effort: "low" } | undefined {
    return model === "gpt-5-nano" ? { effort: "low" } : undefined;
  }

  private normalizeCorrectedText(text: string): string {
    return text.replace(LEADING_FILLER_RE, "");
  }

  private canonicalizeCustomDictionaryTerms(text: string, customDictionary: string[]): string {
    let canonicalized = text;
    for (const term of customDictionary) {
      const canonical = term.trim();
      if (!canonical) continue;

      const pattern = new RegExp(escapeRegExp(canonical), "giu");
      canonicalized = canonicalized.replace(pattern, (match, offset, fullText) => {
        const before = offset > 0 ? fullText[offset - 1] : "";
        const afterIndex = offset + match.length;
        const after = afterIndex < fullText.length ? fullText[afterIndex] : "";
        if (DICTIONARY_TERM_BOUNDARY_RE.test(before) || DICTIONARY_TERM_BOUNDARY_RE.test(after)) {
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
    const { model, apiKey, customDictionary, customInstructions, projectName, projectPath } =
      settings;

    const context: CorrectionPromptContext = {
      projectName,
      projectPath,
      customDictionary,
      customInstructions,
    };
    const systemPrompt = buildCorrectionSystemPrompt(context);
    const userMessage = this.buildUserMessage(request);
    logDebug(`${P} Calling Responses API`, {
      model,
      contextLen: request.recentContext?.length ?? 0,
      reason: request.reason ?? "unspecified",
      segmentCount: request.segmentCount ?? 0,
    });

    const reasoningConfig = this.getReasoningConfig(model);
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...buildOpenAIHeaders(apiKey, settings.organizationId, settings.projectId),
      },
      signal: this.buildFetchSignal(this.getCorrectionTimeoutMs(request)),
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
        ...(reasoningConfig ? { reasoning: reasoningConfig } : {}),
        text: {
          format: {
            type: "json_schema",
            name: "voice_correction_result",
            strict: true,
            schema: CORRECTION_RESULT_SCHEMA,
          },
        },
        max_output_tokens: MAX_OUTPUT_TOKENS,
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.status}`);
    }

    const data = (await response.json()) as {
      output_text?: string;
      output?: Array<{ content?: Array<{ text?: string }> }>;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        input_tokens_details?: { cached_tokens?: number };
      };
    };
    const parsed = JSON.parse(this.extractResponseText(data)) as CorrectionApiResult;

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
