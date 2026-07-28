import { logDebug, logWarn } from "../utils/logger.js";
import { fileSearchService } from "./FileSearchService.js";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";
import { buildOpenAIHeaders } from "../../shared/utils/openaiHeaders.js";
import {
  VOICE_DICTATION_AI_MODEL,
  VOICE_DICTATION_REASONING_EFFORT,
} from "../../shared/config/voiceCorrection.js";

const P = "[VoiceFileLinkResolver]";
const NL_CONFIDENCE_THRESHOLD = 0.67;
const MIN_MATCHING_TOKENS = 2;
const AI_RERANK_TIMEOUT_MS = 4000;
const AI_RERANK_CACHE_PREFIX = "voice-file-rerank-v1";

const AI_RERANK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    matched_file: { type: ["string", "null"] },
  },
  required: ["matched_file"],
} as const;

export class VoiceFileLinkResolver {
  async resolve(payload: {
    cwd: string;
    description: string;
    apiKey: string;
    organizationId?: string;
    projectId?: string;
    signal?: AbortSignal;
  }): Promise<string | null> {
    const { cwd, description, apiKey, organizationId, projectId } = payload;
    if (!cwd || !description.trim()) return null;

    try {
      const candidates = await fileSearchService.searchNaturalLanguage({
        cwd,
        description,
        limit: 20,
      });

      if (candidates.length === 0) {
        logDebug(`${P} No candidates found for "${description}"`);
        return null;
      }

      const tokens = this.extractTokens(description);
      const topScore = this.computeScore(description, candidates[0]);
      if (
        topScore !== null &&
        topScore >= NL_CONFIDENCE_THRESHOLD &&
        tokens.length >= MIN_MATCHING_TOKENS
      ) {
        logDebug(`${P} High-confidence match: ${candidates[0]} (score=${topScore.toFixed(2)})`);
        return candidates[0];
      }

      return await this.aiRerank(
        description,
        candidates,
        apiKey,
        organizationId,
        projectId,
        payload.signal
      );
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return null;
      const msg = formatErrorMessage(error, "Voice file link resolution failed");
      logWarn(`${P} Resolution failed`, { error: msg });
      return null;
    }
  }

  private extractTokens(description: string): string[] {
    const stopWords = new Set([
      "component",
      "file",
      "the",
      "a",
      "an",
      "to",
      "for",
      "of",
      "and",
      "or",
      "in",
      "my",
      "this",
    ]);
    return description
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 0 && !stopWords.has(t))
      .flatMap((t) =>
        t
          .replace(/([a-z])([0-9])/g, "$1 $2")
          .replace(/([0-9])([a-z])/g, "$1 $2")
          .split(/[\s_\-./]+/)
          .filter(Boolean)
      );
  }

  private computeScore(description: string, file: string): number | null {
    const tokens = this.extractTokens(description);
    if (tokens.length === 0) return null;

    const lastSlash = file.lastIndexOf("/");
    const basename = file.slice(lastSlash + 1);
    const nameWithoutExt = basename.replace(/\.[^.]+$/, "");
    const words = nameWithoutExt
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .replace(/([a-zA-Z])([0-9])/g, "$1 $2")
      .replace(/([0-9])([a-zA-Z])/g, "$1 $2")
      .split(/[\s_\-./]+/)
      .filter(Boolean)
      .map((w) => w.toLowerCase());

    let matched = 0;
    for (const token of tokens) {
      if (
        words.some(
          (w) =>
            w === token ||
            (token.length >= 3 && w.length >= 3 && (w.startsWith(token) || token.startsWith(w)))
        )
      ) {
        matched++;
      }
    }

    return matched === 0 ? null : matched / tokens.length;
  }

  private async aiRerank(
    description: string,
    candidates: string[],
    apiKey: string,
    organizationId?: string,
    projectId?: string,
    signal?: AbortSignal
  ): Promise<string | null> {
    logDebug(`${P} AI reranking ${candidates.length} candidates for "${description}"`);

    try {
      const response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...buildOpenAIHeaders(apiKey, organizationId, projectId),
        },
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(AI_RERANK_TIMEOUT_MS)])
          : AbortSignal.timeout(AI_RERANK_TIMEOUT_MS),
        body: JSON.stringify({
          model: VOICE_DICTATION_AI_MODEL,
          instructions:
            "Given a natural language description and a list of file paths from a project, return the path that best matches the description. If no path is a good match, return null.",
          input: `Description: ${description}\n\nCandidates:\n${candidates.map((c, i) => `${i + 1}. ${c}`).join("\n")}`,
          prompt_cache_key: AI_RERANK_CACHE_PREFIX,
          service_tier: "auto",
          reasoning: { effort: VOICE_DICTATION_REASONING_EFFORT },
          text: {
            format: {
              type: "json_schema",
              name: "voice_file_rerank",
              strict: true,
              schema: AI_RERANK_SCHEMA,
            },
          },
          max_output_tokens: 128,
        }),
      });

      if (!response.ok) {
        logWarn(`${P} AI rerank API error: ${response.status}`);
        return null;
      }

      const data = (await response.json()) as {
        output_text?: string;
        output?: Array<{ content?: Array<{ text?: string }> }>;
      };

      const text =
        typeof data.output_text === "string" && data.output_text.trim()
          ? data.output_text
          : data.output?.flatMap((item) => item.content ?? []).find((item) => item.text)?.text;

      if (!text) {
        logWarn(`${P} AI rerank returned empty text`);
        return null;
      }

      const parsed = JSON.parse(text) as { matched_file: string | null };
      const matched = parsed.matched_file?.trim();
      if (matched && candidates.includes(matched)) {
        logDebug(`${P} AI reranked: ${matched}`);
        return matched;
      }

      return null;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return null;
      const msg = formatErrorMessage(error, "Voice AI rerank failed");
      logWarn(`${P} AI rerank failed`, { error: msg });
      return null;
    }
  }
}

export const voiceFileLinkResolver = new VoiceFileLinkResolver();
