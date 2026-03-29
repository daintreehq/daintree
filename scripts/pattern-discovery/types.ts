export type AgentState = "initializing" | "working" | "waiting" | "completed" | "error" | "unknown";

export interface CorpusEntry {
  time: number;
  chunk: string;
  detectedState: AgentState;
  confidence: number;
  agentId: string;
  agentVersion?: string;
}

export interface ClassificationResult {
  customId: string;
  agentState: AgentState;
  indicatorSubstring: string;
  confidence: number;
}

export interface PatternCandidate {
  patternString: string;
  category:
    | "primaryPatterns"
    | "fallbackPatterns"
    | "bootCompletePatterns"
    | "promptPatterns"
    | "completionPatterns";
  confidence: number;
  matchCount: number;
}

export interface DiscoverySession {
  agentId: string;
  agentVersion: string;
  startedAt: string;
  finishedAt: string;
  entryCount: number;
  corpusPath: string;
}

export interface CorpusReplayResult {
  total: number;
  correct: number;
  accuracy: number;
  wrong: Array<{
    entry: CorpusEntry;
    actualState: string;
    actualConfidence: number;
  }>;
}

export interface AnalyzerOutput {
  agentId: string;
  timestamp: string;
  candidates: PatternCandidate[];
  classificationStats: {
    total: number;
    byState: Record<AgentState, number>;
  };
}
