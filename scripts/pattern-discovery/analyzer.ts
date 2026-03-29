import fs from "node:fs";
import path from "node:path";
import { stripAnsi } from "../../electron/services/pty/AgentPatternDetector.js";
import { ensureDir, writeJson } from "../perf/lib/io.js";
import type {
  AgentState,
  AnalyzerOutput,
  ClassificationResult,
  CorpusEntry,
  PatternCandidate,
} from "./types.js";
import { readCorpus } from "./corpus-replay.js";

const CLASSIFICATION_SCHEMA = {
  name: "chunk_classification",
  strict: true,
  schema: {
    type: "object",
    properties: {
      agentState: {
        type: "string",
        enum: ["initializing", "working", "waiting", "completed", "error", "unknown"],
      },
      indicatorSubstring: {
        type: "string",
        description: "The exact substring that indicates this state",
      },
      confidence: {
        type: "number",
        description: "Confidence from 0 to 1",
      },
    },
    required: ["agentState", "indicatorSubstring", "confidence"],
    additionalProperties: false,
  },
};

const HEURISTIC_SCHEMA = {
  name: "pattern_candidates",
  strict: true,
  schema: {
    type: "object",
    properties: {
      patterns: {
        type: "array",
        items: {
          type: "object",
          properties: {
            patternString: {
              type: "string",
              description: "Regex pattern string valid for new RegExp(pattern, 'im')",
            },
            category: {
              type: "string",
              enum: [
                "primaryPatterns",
                "fallbackPatterns",
                "bootCompletePatterns",
                "promptPatterns",
                "completionPatterns",
              ],
            },
            confidence: { type: "number" },
          },
          required: ["patternString", "category", "confidence"],
          additionalProperties: false,
        },
      },
    },
    required: ["patterns"],
    additionalProperties: false,
  },
};

interface AnalyzerOptions {
  corpusPaths: string[];
  agentId: string;
  outDir: string;
  openaiApiKey: string;
  classifyModel: string;
  generateModel: string;
  pollIntervalMs: number;
  maxWaitMs: number;
}

function parseArgs(argv: string[]): AnalyzerOptions {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.replace(/^--/, "");
    const value = argv[i + 1];
    if (value && !value.startsWith("--")) {
      args.set(key, value);
      i++;
    }
  }

  const agentId = args.get("agent");
  if (!agentId) throw new Error("--agent required");

  const corpusDir = args.get("corpus");
  if (!corpusDir) throw new Error("--corpus required (directory or single file)");

  const stat = fs.statSync(corpusDir);
  const corpusPaths = stat.isDirectory()
    ? fs
        .readdirSync(corpusDir)
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => path.join(corpusDir, f))
    : [corpusDir];

  const apiKey = args.get("api-key") ?? process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("--api-key or OPENAI_API_KEY env var required");

  return {
    corpusPaths,
    agentId,
    outDir: args.get("out") ?? path.resolve(process.cwd(), ".tmp/analysis"),
    openaiApiKey: apiKey,
    classifyModel: args.get("classify-model") ?? "gpt-4o-mini",
    generateModel: args.get("generate-model") ?? "gpt-4o",
    pollIntervalMs: Number(args.get("poll-interval") ?? 30_000),
    maxWaitMs: Number(args.get("max-wait") ?? 7_200_000), // 2 hours
  };
}

function buildClassificationBatchLines(
  entries: CorpusEntry[],
  agentId: string,
  model: string
): string[] {
  return entries.map((entry, index) => {
    const cleanChunk = stripAnsi(entry.chunk);
    const body = {
      model,
      messages: [
        {
          role: "system" as const,
          content: `You are analyzing terminal output from the "${agentId}" AI coding agent CLI. Classify the terminal chunk into one of: initializing, working, waiting, completed, error, unknown. Extract the exact indicator substring.`,
        },
        {
          role: "user" as const,
          content: `Classify this terminal output chunk:\n\n${cleanChunk}`,
        },
      ],
      response_format: {
        type: "json_schema" as const,
        json_schema: CLASSIFICATION_SCHEMA,
      },
    };

    return JSON.stringify({
      custom_id: `chunk-${String(index).padStart(5, "0")}`,
      method: "POST",
      url: "/v1/chat/completions",
      body,
    });
  });
}

function buildHeuristicBatchLine(
  classifications: ClassificationResult[],
  agentId: string,
  model: string
): string {
  const byState = new Map<AgentState, string[]>();
  for (const c of classifications) {
    if (c.confidence < 0.7) continue;
    const list = byState.get(c.agentState) ?? [];
    list.push(c.indicatorSubstring);
    byState.set(c.agentState, list);
  }

  const stateGroups = Array.from(byState.entries())
    .map(([state, indicators]) => `${state}:\n${indicators.map((i) => `  - "${i}"`).join("\n")}`)
    .join("\n\n");

  const body = {
    model,
    messages: [
      {
        role: "system" as const,
        content: `You are generating regex patterns for detecting terminal states of the "${agentId}" AI coding agent CLI. Generate patterns valid for \`new RegExp(pattern, "im")\`. Use double-escaped backslashes (e.g., \\\\s not \\s). Patterns should be specific enough to avoid false positives but general enough to survive minor CLI updates.`,
      },
      {
        role: "user" as const,
        content: `Given these classified terminal output indicators grouped by state:\n\n${stateGroups}\n\nGenerate regex patterns for each state category. Map states to categories: working→primaryPatterns+fallbackPatterns, initializing→bootCompletePatterns, waiting→promptPatterns, completed→completionPatterns.`,
      },
    ],
    response_format: {
      type: "json_schema" as const,
      json_schema: HEURISTIC_SCHEMA,
    },
  };

  return JSON.stringify({
    custom_id: "heuristic-gen",
    method: "POST",
    url: "/v1/chat/completions",
    body,
  });
}

async function submitBatch(apiKey: string, batchLines: string[], purpose: string): Promise<string> {
  const OpenAI = (await import("openai")).default;
  const client = new OpenAI({ apiKey });

  const batchContent = batchLines.join("\n");
  const blob = new Blob([batchContent], { type: "application/jsonl" });
  const file = new File([blob], `${purpose}.jsonl`, { type: "application/jsonl" });

  const uploaded = await client.files.create({
    file,
    purpose: "batch",
  });

  const batch = await client.batches.create({
    input_file_id: uploaded.id,
    endpoint: "/v1/chat/completions",
    completion_window: "24h",
  });

  console.log(`[analyzer] Batch "${purpose}" submitted: ${batch.id}`);
  return batch.id;
}

async function pollBatch(
  apiKey: string,
  batchId: string,
  pollIntervalMs: number,
  maxWaitMs: number
): Promise<string | null> {
  const OpenAI = (await import("openai")).default;
  const client = new OpenAI({ apiKey });

  const startTime = Date.now();
  while (Date.now() - startTime < maxWaitMs) {
    const batch = await client.batches.retrieve(batchId);
    console.log(`[analyzer] Batch ${batchId}: status=${batch.status}`);

    if (batch.status === "completed" && batch.output_file_id) {
      const content = await client.files.content(batch.output_file_id);
      return await content.text();
    }

    if (batch.status === "failed" || batch.status === "expired" || batch.status === "cancelled") {
      console.error(`[analyzer] Batch ${batchId} ${batch.status}`);
      return null;
    }

    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  console.error(`[analyzer] Batch ${batchId} timed out after ${maxWaitMs}ms`);
  return null;
}

function parseClassificationResults(output: string): ClassificationResult[] {
  const results: ClassificationResult[] = [];
  for (const line of output.trim().split("\n")) {
    try {
      const entry = JSON.parse(line);
      const content = entry.response?.body?.choices?.[0]?.message?.content;
      if (!content) continue;
      const parsed = JSON.parse(content);
      results.push({
        customId: entry.custom_id,
        agentState: parsed.agentState,
        indicatorSubstring: parsed.indicatorSubstring,
        confidence: parsed.confidence,
      });
    } catch {
      // Skip malformed entries
    }
  }
  return results;
}

function parsePatternCandidates(output: string): PatternCandidate[] {
  const candidates: PatternCandidate[] = [];
  for (const line of output.trim().split("\n")) {
    try {
      const entry = JSON.parse(line);
      const content = entry.response?.body?.choices?.[0]?.message?.content;
      if (!content) continue;
      const parsed = JSON.parse(content);
      for (const p of parsed.patterns ?? []) {
        // Validate regex
        try {
          new RegExp(p.patternString, "im");
          candidates.push({
            patternString: p.patternString,
            category: p.category,
            confidence: p.confidence,
            matchCount: 0,
          });
        } catch {
          console.warn(`[analyzer] Invalid pattern skipped: ${p.patternString}`);
        }
      }
    } catch {
      // Skip malformed entries
    }
  }
  return candidates;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  ensureDir(options.outDir);

  console.log(`[analyzer] Loading corpus for ${options.agentId}`);
  const allEntries: CorpusEntry[] = [];
  for (const p of options.corpusPaths) {
    allEntries.push(...readCorpus(p));
  }
  console.log(`[analyzer] Loaded ${allEntries.length} corpus entries`);

  if (allEntries.length === 0) {
    console.log("[analyzer] No corpus entries, nothing to analyze");
    return;
  }

  // Phase 1: Classification
  console.log("[analyzer] Phase 1: Submitting classification batch");
  const classifyLines = buildClassificationBatchLines(
    allEntries,
    options.agentId,
    options.classifyModel
  );
  const classifyBatchId = await submitBatch(
    options.openaiApiKey,
    classifyLines,
    `classify-${options.agentId}`
  );

  console.log("[analyzer] Polling classification batch...");
  const classifyOutput = await pollBatch(
    options.openaiApiKey,
    classifyBatchId,
    options.pollIntervalMs,
    options.maxWaitMs
  );

  if (!classifyOutput) {
    throw new Error("Classification batch failed");
  }

  const classifications = parseClassificationResults(classifyOutput);
  console.log(`[analyzer] Got ${classifications.length} classifications`);

  const stateCounts: Record<string, number> = {};
  for (const c of classifications) {
    stateCounts[c.agentState] = (stateCounts[c.agentState] ?? 0) + 1;
  }
  console.log("[analyzer] Classification distribution:", stateCounts);

  // Phase 2: Heuristic generation
  console.log("[analyzer] Phase 2: Submitting heuristic generation batch");
  const heuristicLine = buildHeuristicBatchLine(
    classifications,
    options.agentId,
    options.generateModel
  );
  const heuristicBatchId = await submitBatch(
    options.openaiApiKey,
    [heuristicLine],
    `heuristic-${options.agentId}`
  );

  console.log("[analyzer] Polling heuristic batch...");
  const heuristicOutput = await pollBatch(
    options.openaiApiKey,
    heuristicBatchId,
    options.pollIntervalMs,
    options.maxWaitMs
  );

  if (!heuristicOutput) {
    throw new Error("Heuristic generation batch failed");
  }

  const candidates = parsePatternCandidates(heuristicOutput);
  console.log(`[analyzer] Generated ${candidates.length} valid pattern candidates`);

  // Write output
  const output: AnalyzerOutput = {
    agentId: options.agentId,
    timestamp: new Date().toISOString(),
    candidates,
    classificationStats: {
      total: classifications.length,
      byState: stateCounts as Record<AgentState, number>,
    },
  };

  const outputPath = path.join(options.outDir, `${options.agentId}_patterns.json`);
  writeJson(outputPath, output);
  console.log(`[analyzer] Output written to ${outputPath}`);
}

main().catch((error) => {
  console.error("[analyzer] Failed:", error);
  process.exitCode = 1;
});
