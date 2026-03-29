import fs from "node:fs";
import { getAgentConfig } from "../../shared/config/agentRegistry.js";
import { buildPatternConfig } from "../../electron/services/pty/terminalActivityPatterns.js";
import { createPatternDetector } from "../../electron/services/pty/AgentPatternDetector.js";
import type { CorpusEntry, CorpusReplayResult, AgentState } from "./types.js";

export function readCorpus(corpusPath: string): CorpusEntry[] {
  const content = fs.readFileSync(corpusPath, "utf-8").trim();
  if (!content) return [];
  return content.split("\n").map((line) => JSON.parse(line) as CorpusEntry);
}

function patternResultToState(
  isWorking: boolean,
  matchTier: string,
  confidence: number
): AgentState {
  if (isWorking) return "working";
  return "unknown";
}

export function replayCorpus(corpusPath: string, agentId: string): CorpusReplayResult {
  const entries = readCorpus(corpusPath);
  if (entries.length === 0) {
    return { total: 0, correct: 0, accuracy: 1, wrong: [] };
  }

  const detection = getAgentConfig(agentId)?.detection;
  const config = detection ? buildPatternConfig(detection, agentId) : undefined;
  const detector = createPatternDetector(agentId, config ?? undefined);

  let correct = 0;
  const wrong: CorpusReplayResult["wrong"] = [];

  for (const entry of entries) {
    const result = detector.detect(entry.chunk);
    const actualState = patternResultToState(result.isWorking, result.matchTier, result.confidence);

    const isMatch = statesMatch(entry.detectedState, actualState, result.isWorking);
    if (isMatch) {
      correct++;
    } else {
      wrong.push({
        entry,
        actualState,
        actualConfidence: result.confidence,
      });
    }
  }

  return {
    total: entries.length,
    correct,
    accuracy: entries.length > 0 ? correct / entries.length : 1,
    wrong,
  };
}

function statesMatch(expected: AgentState, actual: AgentState, isWorking: boolean): boolean {
  if (expected === "working") return isWorking;
  if (
    expected === "waiting" ||
    expected === "completed" ||
    expected === "initializing" ||
    expected === "error"
  ) {
    return !isWorking;
  }
  return expected === "unknown";
}
