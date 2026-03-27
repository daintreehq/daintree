import { logDebug, logWarn } from "../utils/logger.js";
import {
  CORE_CORRECTION_PROMPT,
  CONFIDENCE_SKIP_THRESHOLD,
  buildCorrectionSystemPrompt,
  buildMicroCorrectionSystemPrompt,
  type CorrectionPromptContext,
} from "../../shared/config/voiceCorrection.js";

export { CORE_CORRECTION_PROMPT, buildCorrectionSystemPrompt };

const P = "[VoiceCorrection]";
const CORRECTION_TIMEOUT_MS = 7000;
const MICRO_CORRECTION_TIMEOUT_MS = 3000;
const MAX_OUTPUT_TOKENS = 1024;
const MICRO_MAX_OUTPUT_TOKENS = 128;
const PROMPT_CACHE_PREFIX = "voice-correction-v4";
const MICRO_PROMPT_CACHE_PREFIX = "voice-micro-correction-v1";
const MICRO_CORRECTION_MODEL = "gpt-5-nano";

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

export interface WordCorrectionRequest {
  uncertainWords: string[];
  leftContext: string;
  rightContext: string;
  rawSpan: string;
}

export class VoiceCorrectionService {
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

      const confirmedText =
        result.action === "no_change"
          ? request.rawText
          : result.correctedText.trim() || request.rawText;

      logDebug(`${P} Correction success`, {
        rawLen: request.rawText.length,
        correctedLen: confirmedText.length,
        action: result.action,
        confidence: result.confidence,
        contextLen: request.recentContext?.length ?? 0,
        reason: request.reason ?? "unspecified",
      });

      return {
        ...result,
        confirmedText,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
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

  async correctWord(
    request: WordCorrectionRequest,
    settings: VoiceCorrectionSettings
  ): Promise<VoiceCorrectionResult> {
    const trimmedSpan = request.rawSpan.trim();
    if (!trimmedSpan) {
      return {
        action: "no_change",
        correctedText: request.rawSpan,
        confidence: "high",
        confirmedText: request.rawSpan,
      };
    }

    try {
      const result = await this.callMicroApi(request, settings);

      const confirmedText =
        result.action === "no_change"
          ? request.rawSpan
          : result.correctedText.trim() || request.rawSpan;

      logDebug(`${P} Micro-correction success`, {
        rawSpan: request.rawSpan,
        confirmedText,
        action: result.action,
      });

      return { ...result, confirmedText };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logWarn(`${P} Micro-correction failed, using raw text`, { error: msg });
      return {
        action: "no_change",
        correctedText: request.rawSpan,
        confidence: "low",
        confirmedText: request.rawSpan,
      };
    }
  }

  private buildMicroUserMessage(request: WordCorrectionRequest): string {
    const parts: string[] = [];

    if (request.leftContext) {
      parts.push(`<left_context>\n${request.leftContext}\n</left_context>`);
    }

    const annotated = VoiceCorrectionService.annotateUncertainWords(
      request.rawSpan,
      request.uncertainWords
    );
    parts.push(`<target>\n${annotated}\n</target>`);

    if (request.rightContext) {
      parts.push(`<right_context>\n${request.rightContext}\n</right_context>`);
    }

    return parts.join("\n\n");
  }

  private buildMicroPromptCacheKey(settings: VoiceCorrectionSettings): string {
    const projectKey = settings.projectName ?? settings.projectPath ?? "global";
    const dictionaryKey =
      settings.customDictionary.length > 0 ? settings.customDictionary.join("|") : "no-dict";
    return `${MICRO_PROMPT_CACHE_PREFIX}:${MICRO_CORRECTION_MODEL}:${projectKey}:${dictionaryKey}`;
  }

  private async callMicroApi(
    request: WordCorrectionRequest,
    settings: VoiceCorrectionSettings
  ): Promise<Omit<VoiceCorrectionResult, "confirmedText">> {
    const context: CorrectionPromptContext = {
      projectName: settings.projectName,
      projectPath: settings.projectPath,
      customDictionary: settings.customDictionary,
    };
    const systemPrompt = buildMicroCorrectionSystemPrompt(context);
    const userMessage = this.buildMicroUserMessage(request);

    logDebug(`${P} Calling micro-correction API`, {
      model: MICRO_CORRECTION_MODEL,
      uncertainWords: request.uncertainWords,
    });

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.apiKey}`,
      },
      signal: AbortSignal.timeout(MICRO_CORRECTION_TIMEOUT_MS),
      body: JSON.stringify({
        model: MICRO_CORRECTION_MODEL,
        instructions: systemPrompt,
        input: userMessage,
        prompt_cache_key: this.buildMicroPromptCacheKey(settings),
        service_tier: "auto",
        reasoning: { effort: "minimal" },
        text: {
          format: {
            type: "json_schema",
            name: "voice_correction_result",
            strict: true,
            schema: CORRECTION_RESULT_SCHEMA,
          },
        },
        max_output_tokens: MICRO_MAX_OUTPUT_TOKENS,
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.status}`);
    }

    const data = (await response.json()) as {
      output_text?: string;
      output?: Array<{ content?: Array<{ text?: string }> }>;
    };
    const parsed = JSON.parse(this.extractResponseText(data)) as CorrectionApiResult;

    return {
      action: parsed.action,
      correctedText: parsed.action === "no_change" ? request.rawSpan : parsed.corrected_text,
      confidence: parsed.confidence,
    };
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

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      signal: AbortSignal.timeout(CORRECTION_TIMEOUT_MS),
      body: JSON.stringify({
        model,
        instructions: systemPrompt,
        input: userMessage,
        prompt_cache_key: this.buildPromptCacheKey(settings),
        service_tier: "auto",
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
    };
    const parsed = JSON.parse(this.extractResponseText(data)) as CorrectionApiResult;

    return {
      action: parsed.action,
      correctedText: parsed.action === "no_change" ? request.rawText : parsed.corrected_text,
      confidence: parsed.confidence,
    };
  }
}
