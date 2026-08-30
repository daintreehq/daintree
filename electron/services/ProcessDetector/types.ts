import type { BuiltInAgentId } from "../../../shared/config/agentIds.js";

export interface ChildProcess {
  pid: number;
  name: string;
  command?: string;
}

/**
 * Which signal inside a single process produced the winning name: its `comm`,
 * a token in its argv, or the basename of its on-disk image. Recorded so a
 * wrong committed identity says *how* it was resolved, not just to what. #11931
 */
export type CandidateMatchSource = "comm" | "argv" | "image_path";

/** The process behind a candidate, carried for the agent-commit diagnostic. */
export interface CandidateProvenance {
  pid: number;
  /** BFS level below the PTY; direct children are 1. */
  depth: number;
  /** Raw `comm` as the OS reported it, before basename/extension stripping. */
  comm: string;
  matchSource: CandidateMatchSource;
}

export interface DetectedProcessCandidate {
  agentType?: BuiltInAgentId;
  processIconId?: string;
  processName: string;
  processCommand?: string;
  priority: number;
  order: number;
  /** Absent when the caller supplied no origin (unit-level construction). */
  provenance?: CandidateProvenance;
}

export interface CommandIdentity {
  agentType?: BuiltInAgentId;
  processIconId?: string;
  processName: string;
}

/**
 * Explicit detection state. Ambiguity is first-class — `unknown` means we have
 * no evidence (cache error, blind `ps`, invalid PID) and should not mutate
 * committed state; `ambiguous` means we have conflicting positive evidence
 * from two independent sources and are holding until one stabilises. Only
 * `agent` and `no_agent` drive actual state changes in consumers.
 */
export type DetectionState = "unknown" | "no_agent" | "agent" | "ambiguous";

/** Which signal produced the committed agent identity, for diagnostics. */
export type DetectionEvidenceSource = "process_tree" | "shell_command" | "both";

export interface DetectionResult {
  detectionState: DetectionState;
  /** @deprecated Use `detectionState === "agent"`. Retained for legacy consumers. */
  detected: boolean;
  agentType?: BuiltInAgentId;
  processIconId?: string;
  processName?: string;
  isBusy?: boolean;
  currentCommand?: string;
  evidenceSource?: DetectionEvidenceSource;
}

export type DetectionCallback = (result: DetectionResult, spawnedAt: number) => void;

/**
 * One detection pass: the public result plus the tree candidate that actually
 * supports it. The candidate rides alongside rather than inside
 * `DetectionResult` because that type crosses to the renderer, and it is
 * returned rather than stashed on the detector so it cannot go stale across
 * the early-return paths (invalid PID, blind `ps`, empty tree). `treeMatch` is
 * null whenever the identity did not come from the process tree.
 */
export interface DetectionPass {
  result: DetectionResult;
  treeMatch: DetectedProcessCandidate | null;
}

export function makeAgentResult(params: {
  agentType?: BuiltInAgentId;
  processIconId?: string;
  processName?: string;
  isBusy?: boolean;
  currentCommand?: string;
  evidenceSource?: DetectionEvidenceSource;
}): DetectionResult {
  return {
    detectionState: "agent",
    detected: true,
    agentType: params.agentType,
    processIconId: params.processIconId,
    processName: params.processName,
    isBusy: params.isBusy,
    currentCommand: params.currentCommand,
    evidenceSource: params.evidenceSource,
  };
}

export function makeNoAgentResult(params: {
  isBusy?: boolean;
  currentCommand?: string;
  evidenceSource?: DetectionEvidenceSource;
}): DetectionResult {
  return {
    detectionState: "no_agent",
    detected: false,
    isBusy: params.isBusy,
    currentCommand: params.currentCommand,
    evidenceSource: params.evidenceSource,
  };
}

export function makeUnknownResult(params?: {
  isBusy?: boolean;
  currentCommand?: string;
}): DetectionResult {
  return {
    detectionState: "unknown",
    detected: false,
    isBusy: params?.isBusy,
    currentCommand: params?.currentCommand,
  };
}

export function makeAmbiguousResult(params: {
  isBusy?: boolean;
  currentCommand?: string;
  evidenceSource?: DetectionEvidenceSource;
}): DetectionResult {
  return {
    detectionState: "ambiguous",
    detected: false,
    isBusy: params.isBusy,
    currentCommand: params.currentCommand,
    evidenceSource: params.evidenceSource,
  };
}
