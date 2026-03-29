import fs from "node:fs";
import path from "node:path";
import { readJson } from "../perf/lib/io.js";
import { replayCorpus } from "./corpus-replay.js";
import type { AnalyzerOutput, PatternCandidate } from "./types.js";

const REGISTRY_PATH = path.resolve(
  import.meta.dirname,
  "../../shared/config/agentRegistry.ts"
);

const CORPUS_DIR = path.resolve(import.meta.dirname, "corpus");

const PATTERN_FIELDS = [
  "primaryPatterns",
  "fallbackPatterns",
  "bootCompletePatterns",
  "promptPatterns",
  "completionPatterns",
] as const;

type PatternField = (typeof PATTERN_FIELDS)[number];

function groupCandidatesByCategory(
  candidates: PatternCandidate[]
): Map<PatternField, string[]> {
  const grouped = new Map<PatternField, string[]>();
  for (const candidate of candidates) {
    if (!PATTERN_FIELDS.includes(candidate.category as PatternField)) continue;
    const field = candidate.category as PatternField;
    const list = grouped.get(field) ?? [];
    list.push(candidate.patternString);
    grouped.set(field, list);
  }
  return grouped;
}

function replacePatternArray(
  source: string,
  agentId: string,
  field: PatternField,
  newPatterns: string[]
): string {
  // Find the agent's detection block and update the specific pattern array.
  // Strategy: find `// @generated:<agentId>:<field>:start` and `:end` sentinel comments.
  const startMarker = `// @generated:${agentId}:${field}:start`;
  const endMarker = `// @generated:${agentId}:${field}:end`;

  const startIdx = source.indexOf(startMarker);
  const endIdx = source.indexOf(endMarker);

  if (startIdx === -1 || endIdx === -1) {
    console.warn(
      `[update-registry] Missing sentinels for ${agentId}.${field}, skipping`
    );
    return source;
  }

  const beforeStart = source.lastIndexOf("\n", startIdx);
  const afterEnd = source.indexOf("\n", endIdx);

  const indent = "        ";
  const patternsStr = newPatterns
    .map((p) => {
      const escaped = p.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      return `${indent}"${escaped}",`;
    })
    .join("\n");

  const replacement = [
    `${indent}${startMarker}`,
    patternsStr,
    `${indent}${endMarker}`,
  ].join("\n");

  return (
    source.slice(0, beforeStart + 1) +
    replacement +
    source.slice(afterEnd)
  );
}

function validatePatterns(patterns: string[]): string[] {
  const valid: string[] = [];
  for (const p of patterns) {
    try {
      new RegExp(p, "im");
      valid.push(p);
    } catch {
      console.warn(`[update-registry] Invalid pattern discarded: ${p}`);
    }
  }
  return valid;
}

interface UpdateOptions {
  analysisPath: string;
  dryRun: boolean;
  minAccuracy: number;
}

function parseArgs(argv: string[]): UpdateOptions {
  const args = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.replace(/^--/, "");
    const value = argv[i + 1];
    if (value && !value.startsWith("--")) {
      args.set(key, value);
      i++;
    } else {
      flags.add(key);
    }
  }

  const analysisPath = args.get("analysis");
  if (!analysisPath) throw new Error("--analysis required (path to analyzer output JSON)");

  return {
    analysisPath,
    dryRun: flags.has("dry-run"),
    minAccuracy: Number(args.get("min-accuracy") ?? 0.9),
  };
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));

  const analysis = readJson<AnalyzerOutput>(options.analysisPath);
  if (!analysis) {
    throw new Error(`Failed to read analysis: ${options.analysisPath}`);
  }

  console.log(
    `[update-registry] Processing ${analysis.candidates.length} candidates for ${analysis.agentId}`
  );

  const grouped = groupCandidatesByCategory(analysis.candidates);
  let source = fs.readFileSync(REGISTRY_PATH, "utf-8");
  let changes = 0;

  for (const [field, patterns] of grouped) {
    const validPatterns = validatePatterns(patterns);
    if (validPatterns.length === 0) {
      console.log(`[update-registry] No valid patterns for ${field}, skipping`);
      continue;
    }

    const newSource = replacePatternArray(source, analysis.agentId, field, validPatterns);
    if (newSource !== source) {
      source = newSource;
      changes++;
      console.log(
        `[update-registry] Updated ${analysis.agentId}.${field}: ${validPatterns.length} patterns`
      );
    }
  }

  if (changes === 0) {
    console.log("[update-registry] No changes to apply");
    return;
  }

  if (options.dryRun) {
    console.log(`[update-registry] Dry run: ${changes} fields would be updated`);
    console.log(source);
    return;
  }

  // Validate with corpus replay BEFORE writing
  const originalSource = fs.readFileSync(REGISTRY_PATH, "utf-8");
  const corpusFiles = fs.existsSync(CORPUS_DIR)
    ? fs.readdirSync(CORPUS_DIR).filter((f) => f.startsWith(analysis.agentId) && f.endsWith(".jsonl"))
    : [];

  if (corpusFiles.length > 0) {
    // Write temporarily to validate, restore on failure
    fs.writeFileSync(REGISTRY_PATH, source, "utf-8");
    let validationFailed = false;

    console.log("[update-registry] Running corpus replay validation...");
    for (const file of corpusFiles) {
      const result = replayCorpus(path.join(CORPUS_DIR, file), analysis.agentId);
      console.log(
        `[update-registry] ${file}: accuracy=${(result.accuracy * 100).toFixed(1)}% (${result.correct}/${result.total})`
      );
      if (result.accuracy < options.minAccuracy) {
        console.error(
          `[update-registry] FAIL: accuracy ${(result.accuracy * 100).toFixed(1)}% < ${options.minAccuracy * 100}%`
        );
        validationFailed = true;
      }
    }

    if (validationFailed) {
      fs.writeFileSync(REGISTRY_PATH, originalSource, "utf-8");
      console.error("[update-registry] Validation failed, registry restored to original");
      process.exitCode = 1;
      return;
    }

    console.log(`[update-registry] Registry updated and validated (${changes} fields)`);
  } else {
    fs.writeFileSync(REGISTRY_PATH, source, "utf-8");
    console.log(`[update-registry] Registry updated (${changes} fields, no corpus for validation)`);
  }
}

main();
