import {
  getEffectiveAgentConfig,
  type AgentDetectionConfig,
} from "../../../shared/config/agentRegistry.js";
import type { PatternDetectionConfig } from "./AgentPatternDetector.js";
import type { ActivityMonitorOptions, ProcessStateValidator } from "../ActivityMonitor.js";
import type { ProcessTreeCache } from "../ProcessTreeCache.js";
import type { VisibleContentSnapshot } from "./SustainedChangeTracker.js";

// Agent status is intentionally output-driven: any observed output means
// working, and sustained silence means waiting. Also the floor for
// debounceMs and promptFastPathMinQuietMs in buildActivityMonitorOptions —
// an intentional jitter guard for silent inter-tool-call gaps (#3606).
const AGENT_WAITING_QUIET_MS = 8000;

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
    getVisibleContentSnapshot?: (n: number) => VisibleContentSnapshot | undefined;
    getCursorLine?: () => string | null;
  }
): ActivityMonitorOptions {
  const agentConfig = effectiveAgentId ? getEffectiveAgentConfig(effectiveAgentId) : undefined;
  // Focus-in/out (CSI I/O) must not stamp lastUserInputAt: a focus click would
  // open the 1s echo window, expire before a slow TUI redraw, and the redraw
  // then flips idle→busy (#8865). Forwarding to the PTY still happens — only
  // the input-tracking side ignores it. Merged unconditionally so every named
  // agent inherits the focus filter without re-listing it in its config.
  const baseIgnored = agentConfig?.capabilities?.ignoredInputSequences ?? ["\x1b\r"];
  const ignoredInputSequences = Array.from(new Set([...baseIgnored, "\x1b[I", "\x1b[O"]));

  const detection = effectiveAgentId
    ? getEffectiveAgentConfig(effectiveAgentId)?.detection
    : undefined;
  const patternConfig = buildPatternConfig(detection, effectiveAgentId);
  const bootCompletePatterns = buildBootCompletePatterns(detection, effectiveAgentId);
  const promptPatterns = buildPromptPatterns(detection, effectiveAgentId);
  const promptHintPatterns = buildPromptHintPatterns(detection, effectiveAgentId);
  const completionPatterns = buildCompletionPatterns(detection, effectiveAgentId);

  // Sample-cadence-invariant leaky bucket (#6666), tuned back toward the
  // v0.7.1 contract: small visible output should recover an agent to working,
  // and sustained silence should return it to waiting. Idle protocol noise is
  // stripped before this detector, so the threshold can remain low.
  const outputActivityDetection = {
    enabled: true,
    leakRatePerMs: 0.032,
    activationThreshold: 32,
    maxBytesPerFrame: 64,
  };

  // Dedicated byte-volume floor for the simpleOutputState early-return path
  // (#10664). Deliberately more conservative than outputActivityDetection: it
  // only recovers waiting→working on a *sustained* stream (>100 B/s for a few
  // seconds), so it ignores the small inter-tool-call writes that
  // simpleOutputState was introduced to tolerate, while still escaping the
  // stuck-waiting state during heavy streaming output. 0.1 B/ms drain means a
  // ~100 B/s flow never fills the 512-byte bucket; heavier flows fire within a
  // few seconds. maxBytesPerFrame caps any single status payload so one burst
  // can't fire alone.
  const simpleOutputVolumeRecovery = {
    enabled: true,
    leakRatePerMs: 0.1,
    activationThreshold: 512,
    maxBytesPerFrame: 256,
  };

  const getVisibleLines = effectiveAgentId ? deps.getVisibleLines : undefined;
  const getVisibleContentSnapshot = effectiveAgentId ? deps.getVisibleContentSnapshot : undefined;
  const getCursorLine = effectiveAgentId ? deps.getCursorLine : undefined;
  let idleDebounceMs: number | undefined;
  let promptFastPathMinQuietMs = detection?.promptFastPathMinQuietMs;
  if (effectiveAgentId) {
    idleDebounceMs = Math.max(
      detection?.debounceMs ?? AGENT_WAITING_QUIET_MS,
      AGENT_WAITING_QUIET_MS
    );
    promptFastPathMinQuietMs = Math.max(
      detection?.promptFastPathMinQuietMs ?? idleDebounceMs,
      idleDebounceMs
    );
  }

  return {
    ignoredInputSequences,
    agentId: effectiveAgentId,
    outputActivityDetection,
    getVisibleLines,
    getVisibleContentSnapshot,
    getCursorLine,
    patternConfig,
    bootCompletePatterns,
    promptPatterns,
    promptHintPatterns,
    completionPatterns,
    completionConfidence: detection?.completionConfidence,
    promptScanLineCount: detection?.promptScanLineCount,
    promptConfidence: detection?.promptConfidence,
    idleDebounceMs,
    promptFastPathMinQuietMs,
    simpleOutputState: effectiveAgentId !== undefined,
    simpleOutputVolumeRecovery:
      effectiveAgentId !== undefined ? simpleOutputVolumeRecovery : undefined,
    maxWaitingSilenceMs: 600_000,
    // Background polling (500ms) shortens the recovery debouncer so
    // backgrounded agents can escape "waiting" when output resumes (#6641).
    // The volume detector is now sample-cadence invariant (#6666) and needs
    // no tier-specific override.
    backgroundWorkingRecoveryDelayMs: 600,
  };
}
