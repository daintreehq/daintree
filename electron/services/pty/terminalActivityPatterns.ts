import {
  getEffectiveAgentConfig,
  type AgentDetectionConfig,
} from "../../../shared/config/agentRegistry.js";
import type { PatternDetectionConfig } from "./AgentPatternDetector.js";
import type { ActivityMonitorOptions, ProcessStateValidator } from "../ActivityMonitor.js";
import type { ProcessTreeCache } from "../ProcessTreeCache.js";

export function buildPatternConfig(
  detection: AgentDetectionConfig | undefined,
  agentId: string | undefined
): PatternDetectionConfig | undefined {
  if (!detection) {
    return undefined;
  }

  const primaryPatterns = compilePatterns(detection.primaryPatterns, agentId, "primary");
  if (primaryPatterns.length === 0) {
    return undefined;
  }

  const fallbackPatterns = detection.fallbackPatterns
    ? compilePatterns(detection.fallbackPatterns, agentId, "fallback")
    : undefined;

  return {
    primaryPatterns,
    fallbackPatterns: fallbackPatterns?.length ? fallbackPatterns : undefined,
    scanLineCount: detection.scanLineCount,
    primaryConfidence: detection.primaryConfidence,
    fallbackConfidence: detection.fallbackConfidence,
  };
}

export function buildBootCompletePatterns(
  detection: AgentDetectionConfig | undefined,
  agentId: string | undefined
): RegExp[] | undefined {
  if (!detection?.bootCompletePatterns || detection.bootCompletePatterns.length === 0) {
    return undefined;
  }

  const bootPatterns = compilePatterns(detection.bootCompletePatterns, agentId, "boot");

  return bootPatterns.length ? bootPatterns : undefined;
}

export function buildPromptPatterns(
  detection: AgentDetectionConfig | undefined,
  agentId: string | undefined
): RegExp[] | undefined {
  if (!detection?.promptPatterns || detection.promptPatterns.length === 0) {
    return undefined;
  }

  const promptPatterns = compilePatterns(detection.promptPatterns, agentId, "prompt");

  return promptPatterns.length ? promptPatterns : undefined;
}

/**
 * Universal approval prompt patterns appended as fallback for all agent terminals.
 * These cover tool-approval prompts from Claude Code, Gemini CLI, Codex CLI,
 * OpenCode, and Cursor Agent. Case-insensitive via compilePatterns().
 */
export const UNIVERSAL_APPROVAL_HINT_PATTERNS: string[] = [
  "allow\\s+once",
  "allow\\s+always",
  "approve\\s+once",
  "approve\\s+this\\s+session",
  "allow\\s+permission",
  "deny\\s+permission",
  "suggest\\s+changes",
  "don['\u2019]t\\s+ask\\s+again",
  "trust\\s+this\\s+directory",
  "\\[y[/\\\\]n\\]",
  "\\(y[/\\\\]n\\)",
  "proceed\\?\\s*\\[y",
];

export function buildPromptHintPatterns(
  detection: AgentDetectionConfig | undefined,
  agentId: string | undefined
): RegExp[] | undefined {
  const agentPatterns =
    detection?.promptHintPatterns && detection.promptHintPatterns.length > 0
      ? compilePatterns(detection.promptHintPatterns, agentId, "prompt hint")
      : [];

  const universalPatterns = agentId
    ? compilePatterns(UNIVERSAL_APPROVAL_HINT_PATTERNS, agentId, "universal approval hint")
    : [];

  const merged = [...agentPatterns, ...universalPatterns];
  return merged.length > 0 ? merged : undefined;
}

export function buildCompletionPatterns(
  detection: AgentDetectionConfig | undefined,
  agentId: string | undefined
): RegExp[] | undefined {
  if (!detection?.completionPatterns || detection.completionPatterns.length === 0) {
    return undefined;
  }

  const completionPatterns = compilePatterns(detection.completionPatterns, agentId, "completion");

  return completionPatterns.length ? completionPatterns : undefined;
}

export function compilePatterns(
  patterns: string[],
  agentId: string | undefined,
  label: string
): RegExp[] {
  const compiled: RegExp[] = [];
  for (const pattern of patterns) {
    try {
      compiled.push(new RegExp(pattern, "im"));
    } catch (error) {
      if (process.env.DAINTREE_VERBOSE) {
        const prefix = agentId ? `${agentId} ${label}` : label;
        console.warn(`[terminalActivityPatterns] Invalid ${prefix} pattern: ${pattern}`, error);
      }
    }
  }
  return compiled;
}

export function createProcessStateValidator(
  ptyPid: number | undefined,
  processTreeCache: ProcessTreeCache | null
): ProcessStateValidator | undefined {
  if (ptyPid === undefined || !processTreeCache) {
    return undefined;
  }

  const shellHelperProcesses = new Set(["gitstatus", "gitstatusd", "async", "zsh-async"]);
  const shellProcesses = new Set(["zsh", "bash", "sh", "fish", "powershell", "pwsh", "cmd"]);
  const CPU_ACTIVITY_THRESHOLD = 0.5;

  return {
    hasActiveChildren: () => {
      if (processTreeCache.hasActiveDescendants(ptyPid, CPU_ACTIVITY_THRESHOLD)) {
        return true;
      }

      const children = processTreeCache.getChildren(ptyPid);
      if (children.length === 0) {
        return false;
      }

      const significantChildren = children.filter((child) => {
        const basename = child.comm.split("/").pop()?.toLowerCase() || child.comm.toLowerCase();
        const name = basename.replace(/\.exe$/, "");
        return !shellHelperProcesses.has(name) && !shellProcesses.has(name);
      });

      return significantChildren.length > 0;
    },
    getDescendantsCpuUsage: () => processTreeCache.getDescendantsCpuUsage(ptyPid),
  };
}

export function buildActivityMonitorOptions(
  effectiveAgentId: string | undefined,
  deps: {
    getVisibleLines?: (n: number) => string[];
    getCursorLine?: () => string | null;
  }
): ActivityMonitorOptions {
  const agentConfig = effectiveAgentId ? getEffectiveAgentConfig(effectiveAgentId) : undefined;
  const ignoredInputSequences = agentConfig?.capabilities?.ignoredInputSequences ?? ["\x1b\r"];

  const detection = effectiveAgentId
    ? getEffectiveAgentConfig(effectiveAgentId)?.detection
    : undefined;
  const patternConfig = buildPatternConfig(detection, effectiveAgentId);
  const bootCompletePatterns = buildBootCompletePatterns(detection, effectiveAgentId);
  const promptPatterns = buildPromptPatterns(detection, effectiveAgentId);
  const promptHintPatterns = buildPromptHintPatterns(detection, effectiveAgentId);
  const completionPatterns = buildCompletionPatterns(detection, effectiveAgentId);

  // Sample-cadence-invariant leaky bucket (#6666). Drains at 100 bytes/sec,
  // fires when ≥200 bytes accumulate, single chunks contribute at most 120
  // bytes (the noise gate that prevents one oversized status-line write from
  // tripping the gate). At 50ms tier with 50-byte chunks the bucket fills in
  // ~5 frames; at 500ms tier with 100-byte chunks it fills in 3 frames —
  // identical work-detection sensitivity at either polling cadence.
  const outputActivityDetection = {
    enabled: true,
    leakRatePerMs: 0.1,
    activationThreshold: 200,
    maxBytesPerFrame: 120,
  };

  const getVisibleLines = effectiveAgentId ? deps.getVisibleLines : undefined;
  const getCursorLine = effectiveAgentId ? deps.getCursorLine : undefined;

  return {
    ignoredInputSequences,
    agentId: effectiveAgentId,
    outputActivityDetection,
    getVisibleLines,
    getCursorLine,
    patternConfig,
    bootCompletePatterns,
    promptPatterns,
    promptHintPatterns,
    completionPatterns,
    completionConfidence: detection?.completionConfidence,
    promptScanLineCount: detection?.promptScanLineCount,
    promptConfidence: detection?.promptConfidence,
    idleDebounceMs: effectiveAgentId ? (detection?.debounceMs ?? 4000) : undefined,
    promptFastPathMinQuietMs: detection?.promptFastPathMinQuietMs,
    maxWaitingSilenceMs: 600_000,
    // Background polling (500ms) shortens the recovery debouncer so
    // backgrounded agents can escape "waiting" when output resumes (#6641).
    // The volume detector is now sample-cadence invariant (#6666) and needs
    // no tier-specific override.
    backgroundWorkingRecoveryDelayMs: 600,
  };
}
