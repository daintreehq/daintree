import { logDebug, logWarn } from "../utils/logger.js";
import { fileSearchService } from "./FileSearchService.js";
import { buildOpenAIHeaders } from "../../shared/utils/openaiHeaders.js";
import {
  VOICE_DICTATION_AI_MODEL,
  VOICE_DICTATION_REASONING_EFFORT,
} from "../../shared/config/voiceCorrectionPolicy.js";

const P = "[VoiceFileLinkResolver]";
const NL_CONFIDENCE_THRESHOLD = 0.67;
const MIN_MATCHING_TOKENS = 2;
const AI_RERANK_TIMEOUT_MS = 4000;
const AI_RERANK_CACHE_PREFIX = "voice-file-rerank-v1";
/** How many paths a search offers for one description. */
export const FILE_LINK_CANDIDATE_LIMIT = 20;

interface PickRequest {
  description: string;
  apiKey: string;
  organizationId?: string;
  projectId?: string;
  signal?: AbortSignal;
}

const AI_RERANK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    matched_file: { type: ["string", "null"] },
  },
  required: ["matched_file"],
} as const;

/**
 * Resolves to null only when the search or reranker found no match. A lookup
 * that couldn't finish (a failed search, an API error, the rerank's own
 * timeout, an unreadable reply) rejects instead, so it isn't reported as a
 * miss (#14983). One its caller aborted resolves to null: the caller has
 * stopped listening.
 */
export class VoiceFileLinkResolver {
  async resolve(payload: {
    cwd: string;
    description: string;
    apiKey: string;
    organizationId?: string;
    projectId?: string;
    signal?: AbortSignal;
  }): Promise<string | null> {
    const { cwd, description } = payload;
    if (!cwd || !description.trim()) return null;

    try {
      const candidates = await fileSearchService.searchNaturalLanguage({
        cwd,
        description,
        limit: FILE_LINK_CANDIDATE_LIMIT,
      });
      return await this.pick({ ...payload, candidates });
    } catch (error) {
      if (payload.signal?.aborted) return null;
      throw error;
    }
  }

  /**
   * The path among `candidates`, best first as a search ranked them, that
   * `description` names. For a search run elsewhere: a host searches its own
   * files, and the choice is made here with this machine's credentials.
   */
  async pick(payload: PickRequest & { candidates: readonly string[] }): Promise<string | null> {
    const { candidates, description, apiKey, organizationId, projectId } = payload;
    if (!description.trim()) return null;
    if (candidates.length === 0) {
      logDebug(`${P} No candidates found`, { descriptionLength: description.length });
      return null;
    }

    const tokens = this.extractTokens(description);
    if (tokens.length >= MIN_MATCHING_TOKENS) {
      const best = this.strongestMatches(tokens, candidates);
      if (best && best.score >= NL_CONFIDENCE_THRESHOLD) {
        // Same-named files in different directories score alike: with nothing
        // in the description to tell them apart, the first one the search
        // happened to list is a guess, so the reranker gets to decline instead.
        if (best.paths.length === 1) {
          logDebug(`${P} High-confidence match`, { score: Number(best.score.toFixed(2)) });
          return best.paths[0];
        }
        logDebug(`${P} Equally strong matches`, {
          score: Number(best.score.toFixed(2)),
          tied: best.paths.length,
        });
      }
    }

    return this.aiRerank(
      description,
      [...candidates],
      apiKey,
      organizationId,
      projectId,
      payload.signal
    );
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

  private splitWords(name: string): string[] {
    return name
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .replace(/([a-zA-Z])([0-9])/g, "$1 $2")
      .replace(/([0-9])([a-zA-Z])/g, "$1 $2")
      .split(/[\s_\-./]+/)
      .filter(Boolean)
      .map((w) => w.toLowerCase());
  }

  private wordMatches(word: string, token: string): boolean {
    return (
      word === token ||
      (token.length >= 3 && word.length >= 3 && (word.startsWith(token) || token.startsWith(word)))
    );
  }

  /**
   * How well `file` fits the spoken tokens. The file's own name has to match at
   * least one, so a directory alone never selects a file. A token the name
   * doesn't carry still counts when a directory does ("app user profile" names
   * `app/UserProfile.tsx` over `lib/UserProfile.tsx`). `extraWords` is how much of
   * the name the description left unsaid, which separates `UserProfile.tsx` from
   * its `UserProfile.test.tsx` sibling.
   */
  private scorePath(
    tokens: readonly string[],
    file: string
  ): { score: number; extraWords: number } | null {
    const lastSlash = file.lastIndexOf("/");
    const nameWords = this.splitWords(file.slice(lastSlash + 1).replace(/\.[^.]+$/, ""));
    const dirWords =
      lastSlash > 0 ? this.splitWords(file.slice(0, lastSlash).replace(/\//g, " ")) : [];

    let nameMatched = 0;
    let dirMatched = 0;
    for (const token of tokens) {
      if (nameWords.some((w) => this.wordMatches(w, token))) nameMatched++;
      else if (dirWords.some((w) => this.wordMatches(w, token))) dirMatched++;
    }
    if (nameMatched === 0) return null;

    const sayable = nameWords.filter((w) => tokens.some((t) => this.wordMatches(w, t))).length;
    return {
      score: (nameMatched + dirMatched) / tokens.length,
      extraWords: nameWords.length - sayable,
    };
  }

  /** Every candidate that fits the tokens best, so a tie is seen rather than broken by list order. */
  private strongestMatches(
    tokens: readonly string[],
    candidates: readonly string[]
  ): { score: number; paths: string[] } | null {
    let best: { score: number; extraWords: number; paths: Set<string> } | null = null;
    for (const file of candidates) {
      const fit = this.scorePath(tokens, file);
      if (!fit) continue;
      if (
        !best ||
        fit.score > best.score ||
        (fit.score === best.score && fit.extraWords < best.extraWords)
      ) {
        best = { ...fit, paths: new Set([file]) };
      } else if (fit.score === best.score && fit.extraWords === best.extraWords) {
        best.paths.add(file);
      }
    }
    return best && { score: best.score, paths: [...best.paths] };
  }

  private async aiRerank(
    description: string,
    candidates: string[],
    apiKey: string,
    organizationId?: string,
    projectId?: string,
    signal?: AbortSignal
  ): Promise<string | null> {
    logDebug(`${P} AI reranking`, {
      candidateCount: candidates.length,
      descriptionLength: description.length,
    });

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
            "Given a natural language description and a list of file paths from a project, return the path that best matches the description. If no path is a good match, return null. If several paths match equally well and the description does not say which one is meant, return null rather than guessing.",
          input: `Description: ${description}\n\nCandidates:\n${candidates.map((c, i) => `${i + 1}. ${c}`).join("\n")}`,
          prompt_cache_key: AI_RERANK_CACHE_PREFIX,
          service_tier: "auto",
          store: false,
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
        throw new Error("AI rerank API error");
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
        throw new Error("AI rerank returned empty text");
      }

      const parsed = JSON.parse(text) as { matched_file: string | null };
      const matched = parsed.matched_file?.trim();
      if (matched && candidates.includes(matched)) {
        logDebug(`${P} AI reranked`);
        return matched;
      }

      return null;
    } catch (error) {
      if (signal?.aborted) return null;
      throw error;
    }
  }
}

export const voiceFileLinkResolver = new VoiceFileLinkResolver();
