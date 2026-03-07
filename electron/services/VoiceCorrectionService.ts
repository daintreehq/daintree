import { logDebug, logWarn } from "../utils/logger.js";
import {
  CORE_CORRECTION_PROMPT,
  buildCorrectionSystemPrompt,
  type CorrectionPromptContext,
} from "../../shared/config/voiceCorrection.js";

export { CORE_CORRECTION_PROMPT, buildCorrectionSystemPrompt };

const P = "[VoiceCorrection]";
const CORRECTION_TIMEOUT_MS = 5000;
const MAX_HISTORY = 3;
// gpt-5-nano is a reasoning model that uses internal reasoning tokens before
// producing visible output. 1024 gives enough headroom for ~700 reasoning
// tokens plus the corrected sentence output.
const MAX_COMPLETION_TOKENS = 1024;

export interface VoiceCorrectionSettings {
  model: string;
  apiKey: string;
  customDictionary: string[];
  customInstructions?: string;
  projectName?: string;
  projectPath?: string;
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

    // User message: only history + raw text (changes every request)
    const userParts: string[] = [];

    if (this.history.length > 0) {
      userParts.push(`Previous sentences:\n${this.history.map((s) => `- ${s}`).join("\n")}`);
    }

    userParts.push(`Correct this sentence:\n${rawText}`);

    const userMessage = userParts.join("\n\n");

    // GPT-5 family models are reasoning models that require different API parameters
    const isReasoningModel = model.startsWith("gpt-5");

    logDebug(`${P} Calling Chat Completions`, { model, historyLen: this.history.length });

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          // GPT-5 reasoning models use "developer" role for instructions
          { role: isReasoningModel ? "developer" : "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
        // Reasoning models (gpt-5-nano) don't support temperature and need
        // reasoning_effort to limit internal chain-of-thought token usage.
        ...(isReasoningModel ? { reasoning_effort: "low" } : { temperature: 0 }),
        max_completion_tokens: MAX_COMPLETION_TOKENS,
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.status}`);
    }

    const data = (await response.json()) as {
      choices: Array<{ message: { content: string | null } }>;
    };

    const content = data.choices[0]?.message?.content;
    if (!content) {
      throw new Error("No content in API response");
    }

    return content;
  }
}
