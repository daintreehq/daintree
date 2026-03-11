import { logDebug, logWarn } from "../utils/logger.js";
import {
  CORE_CORRECTION_PROMPT,
  buildCorrectionSystemPrompt,
  type CorrectionPromptContext,
} from "../../shared/config/voiceCorrection.js";

export { CORE_CORRECTION_PROMPT, buildCorrectionSystemPrompt };

const P = "[VoiceCorrection]";
const CORRECTION_TIMEOUT_MS = 7000;
const MAX_HISTORY = 3;
const MAX_OUTPUT_TOKENS = 256;
const PROMPT_CACHE_PREFIX = "voice-correction-v2";

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

interface CorrectionApiResult {
  action: "no_change" | "replace";
  corrected_text: string;
  confidence: "low" | "medium" | "high";
}

export class VoiceCorrectionService {
  private history: string[] = [];

  resetHistory(): void {
    this.history = [];
  }

  async correct(rawText: string, settings: VoiceCorrectionSettings): Promise<string> {
    const trimmedRaw = rawText.trim();
    if (!trimmedRaw) return rawText;

    try {
      const result = await Promise.race([
        this.callApi(trimmedRaw, settings),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Correction timeout")), CORRECTION_TIMEOUT_MS)
        ),
      ]);

      const corrected = result.trim();
      if (!corrected) {
        logWarn(`${P} API returned empty result, using raw text`);
        this.pushHistory(trimmedRaw);
        return rawText;
      }

      logDebug(`${P} Correction success`, {
        rawLen: rawText.length,
        correctedLen: corrected.length,
      });
      this.pushHistory(corrected);
      return corrected;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logWarn(`${P} Correction failed, using raw text`, { error: msg });
      this.pushHistory(trimmedRaw);
      return rawText;
    }
  }

  private pushHistory(sentence: string): void {
    this.history.push(sentence);
    if (this.history.length > MAX_HISTORY) {
      this.history.shift();
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

  private async callApi(rawText: string, settings: VoiceCorrectionSettings): Promise<string> {
    const { model, apiKey, customDictionary, customInstructions, projectName, projectPath } =
      settings;

    // System message: core prompt + context (cached across requests)
    const context: CorrectionPromptContext = {
      projectName,
      projectPath,
      customDictionary,
      customInstructions,
    };
    const systemPrompt = buildCorrectionSystemPrompt(context);

    // User message: history (for context) + current sentence to correct
    const userParts: string[] = [];

    if (this.history.length > 0) {
      userParts.push(
        `<history>\n${this.history.map((s, i) => `${i + 1}. ${s}`).join("\n")}\n</history>`
      );
    }

    userParts.push(`<input>\n${rawText}\n</input>`);

    const userMessage = userParts.join("\n\n");

    const isReasoningModel = model.startsWith("gpt-5");

    logDebug(`${P} Calling Responses API`, { model, historyLen: this.history.length });

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        instructions: systemPrompt,
        input: userMessage,
        prompt_cache_key: this.buildPromptCacheKey(settings),
        service_tier: "auto",
        ...(isReasoningModel
          ? { reasoning: { effort: model === "gpt-5-mini" ? "medium" : "low" } }
          : {}),
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

    if (parsed.action === "no_change") {
      return rawText;
    }

    return parsed.corrected_text;
  }
}
