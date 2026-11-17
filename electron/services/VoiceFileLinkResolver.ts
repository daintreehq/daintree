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

const baseNameOf = (file: string): string => file.slice(file.lastIndexOf("/") + 1);
/** What makes two paths "the same file name" in different directories, however it is cased. */
const nameKeyOf = (file: string): string => baseNameOf(file).toLowerCase();
const extensionOf = (file: string): string | null => {
  const match = /\.([^.]+)$/.exec(baseNameOf(file));
  return match ? match[1].toLowerCase() : null;
};

interface PathFit {
  score: number;
  nameMatched: number;
  /** 1 when the description named the file's own extension. */
  extensionMatched: number;
  extraWords: number;
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
 * Resolves to null only when the search or reranker found no match, or when
 * several files fit the description equally well. A lookup that couldn't
 * finish (a failed search, an API error, the rerank's own timeout, an
 * unreadable reply) rejects instead, so it isn't reported as a miss (#14983).
 * One its caller aborted resolves to null: the caller has stopped listening.
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
    const extensions = this.extensionsOf(candidates);

    if (tokens.length >= MIN_MATCHING_TOKENS) {
      const best = this.strongestMatches(tokens, extensions, candidates);
      if (best && best.score >= NL_CONFIDENCE_THRESHOLD) {
        if (best.paths.length === 1) {
          logDebug(`${P} High-confidence match`, { score: Number(best.score.toFixed(2)) });
          return best.paths[0];
        }
        // Same-named files in different directories fit a description alike, and
        // nothing in it tells them apart: any one of them is a guess. A miss is
        // reported and the spoken words stay. Differently named files that merely
        // score alike are for the reranker.
        const name = nameKeyOf(best.paths[0]);
        if (best.paths.every((file) => nameKeyOf(file) === name)) {
          logDebug(`${P} Equally strong matches`, {
            score: Number(best.score.toFixed(2)),
            tied: best.paths.length,
          });
          return null;
        }
      }
    }

    const matched = await this.aiRerank(
      description,
      [...candidates],
      apiKey,
      organizationId,
      projectId,
      payload.signal
    );
    // The reranker sees no more of the project than the scorer does, so a pick
    // with a same-named twin the description fits at least as well is a guess too.
    if (matched && this.hasEquallyFittingTwin(tokens, extensions, matched, candidates)) {
      logDebug(`${P} Rerank chose among same-named matches`);
      return null;
    }
    return matched;
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
   * doesn't carry still counts when a directory word is exactly it ("app user
   * profile" names `app/UserProfile.tsx` over `lib/UserProfile.tsx`), unless it
   * is an extension some candidate has: "tsx" names a file type before it names
   * a `tsx/` folder. Past the score, more name matches outweigh directory ones,
   * then a named extension decides, and `extraWords` is how much of the name the
   * description never said outright, which separates `UserProfile.tsx` from its
   * `UserProfile.test.tsx` and `UserProfiler.tsx` neighbours.
   */
  private scorePath(
    tokens: readonly string[],
    extensions: ReadonlySet<string>,
    file: string
  ): PathFit | null {
    const lastSlash = file.lastIndexOf("/");
    const nameWords = this.splitWords(file.slice(lastSlash + 1).replace(/\.[^.]+$/, ""));
    const dirWords =
      lastSlash > 0 ? this.splitWords(file.slice(0, lastSlash).replace(/\//g, " ")) : [];

    let nameMatched = 0;
    let dirMatched = 0;
    for (const token of tokens) {
      if (nameWords.some((w) => this.wordMatches(w, token))) nameMatched++;
      else if (!extensions.has(token) && dirWords.includes(token)) dirMatched++;
    }
    if (nameMatched === 0) return null;

    const extension = extensionOf(file);
    return {
      score: (nameMatched + dirMatched) / tokens.length,
      nameMatched,
      extensionMatched: extension !== null && tokens.includes(extension) ? 1 : 0,
      // A word the tokenizer drops (of, the, component) was never evidence either way.
      extraWords: nameWords.filter((w) => !tokens.includes(w) && this.extractTokens(w).length > 0)
        .length,
    };
  }

  private extensionsOf(candidates: readonly string[]): Set<string> {
    const extensions = new Set<string>();
    for (const file of candidates) {
      const extension = extensionOf(file);
      if (extension) extensions.add(extension);
    }
    return extensions;
  }

  private fitsBetter(a: PathFit, b: PathFit): number {
    return (
      a.score - b.score ||
      a.nameMatched - b.nameMatched ||
      a.extensionMatched - b.extensionMatched ||
      b.extraWords - a.extraWords
    );
  }

  /** Every candidate that fits the tokens best, so a tie is seen rather than broken by list order. */
  private strongestMatches(
    tokens: readonly string[],
    extensions: ReadonlySet<string>,
    candidates: readonly string[]
  ): { score: number; paths: string[] } | null {
    let best: (PathFit & { paths: Set<string> }) | null = null;
    for (const file of candidates) {
      const fit = this.scorePath(tokens, extensions, file);
      if (!fit) continue;
      const order = best ? this.fitsBetter(fit, best) : 1;
      if (order > 0) best = { ...fit, paths: new Set([file]) };
      else if (order === 0) best!.paths.add(file);
    }
    return best && { score: best.score, paths: [...best.paths] };
  }

  /** Another candidate with the picked file's name, in another directory, that the description fits at least as well. */
  private hasEquallyFittingTwin(
    tokens: readonly string[],
    extensions: ReadonlySet<string>,
    picked: string,
    candidates: readonly string[]
  ): boolean {
    const fit = this.scorePath(tokens, extensions, picked);
    if (!fit) return false;
    const name = nameKeyOf(picked);
    return candidates.some((file) => {
      if (file === picked || nameKeyOf(file) !== name) return false;
      const twin = this.scorePath(tokens, extensions, file);
      return twin !== null && this.fitsBetter(twin, fit) >= 0;
    });
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
            "Given a natural language description and a list of file paths from a project, return the path that best matches the description. If no path is a good match, return null.",
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
