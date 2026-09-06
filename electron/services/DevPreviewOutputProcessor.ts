import type { DevPreviewSessionStatus } from "../../shared/types/ipc/devPreview.js";
import type { DevServerError } from "../../shared/utils/devServerErrors.js";
import { detectDevServerError } from "../../shared/utils/devServerErrors.js";
import { PERF_MARKS } from "../../shared/perf/marks.js";
import { markPerformance } from "../utils/performance.js";
import { CRASH_SIGNALS, EXPECTED_TERMINATION_SIGNALS } from "./pty/terminalForensics.js";
import { capDiagnosticText, type DevPreviewDiagnosticInput } from "./DevPreviewDiagnosticsRing.js";
import type { ScanResult, UrlDetector } from "./UrlDetector.js";

const COMPILE_ARM_MS = 1000;
const COMPILE_CLEAR_MS = 1500;

export interface OutputProcessorSession {
  panelId: string;
  projectId: string;
  status: DevPreviewSessionStatus;
  url: string | null;
  pendingUrl: string | null;
  buffer: string;
  readinessAbort: AbortController | null;
  markerSeen: boolean;
  generation: number;
  isRunningInstall: boolean;
  needsInstall: boolean;
  lastErrorKey: string | null;
  compiling: boolean;
  compilingTimer: ReturnType<typeof setTimeout> | null;
  compilingClearTimer: ReturnType<typeof setTimeout> | null;
}

export interface OutputProcessorSessionUpdate {
  status?: DevPreviewSessionStatus;
  url?: string | null;
  predictedUrl?: string | null;
  error?: DevServerError | null;
  isRestarting?: boolean;
  phaseLabel?: "Compiling";
}

export interface OutputProcessorDeps<TSession extends OutputProcessorSession> {
  detector: Pick<UrlDetector, "scanOutput">;
  textDecoder: TextDecoder;
  recordSessionDiagnostic(session: TSession, input: DevPreviewDiagnosticInput): void;
  updateSession(session: TSession, updates: OutputProcessorSessionUpdate): void;
  emitStateChanged(session: TSession): void;
  clearCompiling(session: TSession): void;
  pollServerReadiness(
    session: TSession,
    url: string,
    signal: AbortSignal,
    generation: number
  ): void;
}

/**
 * Process one chunk of dev-server terminal output: URL/readiness detection,
 * compile-marker timers, and output-based error classification. Mirrors the
 * orchestrator's former `handleData` body exactly — callers are expected to
 * have already checked disposal/session-lookup/terminal-id-match.
 */
export function processDevPreviewOutput<TSession extends OutputProcessorSession>(
  session: TSession,
  terminalId: string,
  data: string | Uint8Array,
  deps: OutputProcessorDeps<TSession>
): void {
  if (session.isRunningInstall) return;

  const dataString = typeof data === "string" ? data : deps.textDecoder.decode(data);
  const result: ScanResult = deps.detector.scanOutput(dataString, session.buffer);
  session.buffer = result.buffer;

  let urlJustStarted = false;
  if (result.url && result.url !== session.url && result.url !== session.pendingUrl) {
    markPerformance(PERF_MARKS.DEVPREVIEW_URL_DETECTED, {
      panelId: session.panelId,
      projectId: session.projectId,
      terminalId,
      url: result.url,
    });
    deps.recordSessionDiagnostic(session, {
      type: "url-detected",
      url: capDiagnosticText(result.url),
    });

    session.readinessAbort?.abort();
    const abort = new AbortController();
    session.readinessAbort = abort;
    session.pendingUrl = result.url;
    // A new URL (e.g. a port change) starts a fresh poll; allow its own
    // readiness marker to accelerate it again.
    session.markerSeen = false;

    deps.pollServerReadiness(session, result.url, abort.signal, session.generation);
    urlJustStarted = true;
  }

  // A framework readiness line ("ready in N ms", "✓ Ready in", "compiled
  // successfully") confirms the HTTP server is bound. When a poll is already
  // mid-cycle (sleeping between HEAD attempts), abort it and re-probe now to
  // skip the remaining poll interval. The poll itself stays the fallback for
  // unrecognized frameworks, so no marker means no behavior change.
  if (result.readyMarker && !session.markerSeen && !urlJustStarted && session.pendingUrl) {
    session.markerSeen = true;
    session.readinessAbort?.abort();
    const abort = new AbortController();
    session.readinessAbort = abort;
    deps.pollServerReadiness(session, session.pendingUrl, abort.signal, session.generation);
  }

  // Compile marker detection fires whenever the framework emits a
  // compile-start line (HMR rebuild, initial compilation burst). Uses a
  // two-stage timer: arm debounce prevents flicker from rapid marker
  // bursts, auto-clear removes the signal when markers go quiet.
  if (
    result.compileMarker &&
    session.status !== "stopped" &&
    session.status !== "error" &&
    !session.isRunningInstall
  ) {
    if (session.compiling) {
      // Already visible — reset the auto-clear timer so the signal
      // persists through a burst (HMR chains, multi-file saves).
      if (session.compilingClearTimer !== null) {
        clearTimeout(session.compilingClearTimer);
        session.compilingClearTimer = setTimeout(() => {
          session.compilingClearTimer = null;
          deps.recordSessionDiagnostic(session, { type: "compile-cleared" });
          deps.clearCompiling(session);
          deps.emitStateChanged(session);
        }, COMPILE_CLEAR_MS);
      }
    } else if (session.compilingTimer === null) {
      // Start the arm debounce — if no additional markers arrive before
      // COMPILE_ARM_MS, publish the Compiling label.
      session.compilingTimer = setTimeout(() => {
        session.compilingTimer = null;
        if (
          session.status === "stopped" ||
          session.status === "error" ||
          session.isRunningInstall
        ) {
          return;
        }
        session.compiling = true;
        deps.recordSessionDiagnostic(session, { type: "compile-started" });
        deps.updateSession(session, { phaseLabel: "Compiling" });
        session.compilingClearTimer = setTimeout(() => {
          session.compilingClearTimer = null;
          deps.recordSessionDiagnostic(session, { type: "compile-cleared" });
          deps.clearCompiling(session);
          deps.emitStateChanged(session);
        }, COMPILE_CLEAR_MS);
      }, COMPILE_ARM_MS);
    }
  }

  // A readyMarker during an active compile phase cancels both timers
  // and clears the label early — the framework signaled completion.
  if (result.readyMarker && (session.compiling || session.compilingTimer !== null)) {
    if (session.compilingTimer !== null) {
      clearTimeout(session.compilingTimer);
      session.compilingTimer = null;
    }
    if (session.compiling) {
      deps.recordSessionDiagnostic(session, { type: "compile-cleared" });
    }
    deps.clearCompiling(session);
    deps.emitStateChanged(session);
  }

  if (!result.error) return;
  const errorKey = `${result.error.type}:${result.error.message}`;
  if (errorKey === session.lastErrorKey) return;
  session.lastErrorKey = errorKey;
  deps.recordSessionDiagnostic(session, {
    type: "output-error",
    errorType: result.error.type,
    message: capDiagnosticText(result.error.message),
  });

  // Cancel any in-flight readiness poll: a server that still answers HEAD on
  // a half-started port would otherwise resolve to "running" and clobber the
  // error/installing status we are about to set.
  session.readinessAbort?.abort();
  session.readinessAbort = null;
  session.pendingUrl = null;
  session.markerSeen = false;
  deps.clearCompiling(session);

  if (result.error.type === "missing-dependencies") {
    // Arm the install the next terminal exit will run — but stay honest about
    // what has actually happened. `installing` belongs to runInstall; claiming
    // it here showed users an install that had not begun (#12295).
    session.needsInstall = true;
    deps.updateSession(session, {
      status: "starting",
      error: result.error,
      isRestarting: false,
    });
    return;
  }

  deps.updateSession(session, {
    status: "error",
    error: result.error,
    url: null,
    predictedUrl: null,
    isRestarting: false,
    phaseLabel: undefined,
  });
}

/**
 * Classify a dev-server terminal exit into a user-facing error, or null for a
 * clean/expected termination. Signal-based tiers are checked first (OOM,
 * process-crash, expected-termination), then output-based detection, then an
 * exit-code fallback.
 */
export function classifyDevPreviewExit(
  exitCode: number,
  signal: number | undefined,
  recentOutput: string
): DevServerError | null {
  // Signal-based tier first
  if (signal !== undefined) {
    // Check OOM output across all crash signals — Node.js heap OOM sends
    // SIGABRT (6), not SIGKILL (9). Kernel OOM killer uses SIGKILL.
    if (
      CRASH_SIGNALS.has(signal) &&
      /\b(FATAL ERROR|out of memory|heap out of memory|Cannot allocate memory)\b/i.test(
        recentOutput
      )
    ) {
      return {
        type: "oom",
        message: "Dev server was killed — out of memory.",
      };
    }
    if (signal === 9) {
      // SIGKILL without OOM output: fall through to output/exit-code tiers
    } else if (CRASH_SIGNALS.has(signal)) {
      return {
        type: "process-crash",
        message: `Dev server crashed (signal ${signal}).`,
      };
    }
    if (EXPECTED_TERMINATION_SIGNALS.has(signal)) {
      return null;
    }
  }

  // Output-based tier
  const outputError = detectDevServerError(recentOutput);
  if (outputError) return outputError;

  // Exit-code fallback
  if (exitCode === 0) return null;
  return {
    type: "unknown",
    message: `Dev server exited with code ${exitCode}`,
  };
}
