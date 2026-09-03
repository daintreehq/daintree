import { getEffectiveAgentConfig } from "../../../shared/config/agentRegistry.js";
import { supportsSessionIdAssignment } from "../../../shared/types/agentSettings.js";
import { getGitBranch } from "../../utils/gitUtils.js";
import { createLogger } from "../../utils/logger.js";
import { events } from "../events.js";
import { createSessionIdMatcher } from "./sessionIdCapture.js";
import type { TerminalInfo } from "./types.js";

const logger = createLogger("pty:AgentEndCapture");

/**
 * Non-blank trailing lines of rolling output the passive scrape will trust.
 *
 * The forensic buffer is a purpose-agnostic 4000-char tail that keeps filling
 * after the agent is gone, so the same `codex resume <id>` text can sit in it as
 * ordinary conversation. Taking the last match is not enough on its own: with no
 * real hint printed, the last match would still be that conversational mention.
 * Four lines is the same evidence horizon `IdentityWatcher` already trusts for
 * prompt-return detection (`SHELL_IDENTITY_FALLBACK_SCAN_LINES`), and it
 * comfortably spans an exit hint plus the shell prompt that follows it.
 */
const CAPTURE_SCAN_LINES = 4;

/**
 * Which lifecycle boundary is asking. `exit` is the agent's PTY going away;
 * `demotion` is the agent process ending while the pane survives as a shell.
 */
export type AgentEndBoundary = "exit" | "demotion";

type AgentEndCaptureOutcome =
  "captured" | "preassigned" | "no-resume-config" | "no-pattern" | "no-match" | "needs-boundary";

interface AgentEndCaptureArgs {
  terminalId: string;
  terminal: TerminalInfo;
  /** Agent that just ended — the one whose hint is in the output. */
  agentId: string;
  boundary: AgentEndBoundary;
  /** Forensic tail, snapshotted before any teardown that would clear it. */
  recentOutput: string;
}

/**
 * Journal the resumable session of an agent that ended on its own — a natural
 * PTY exit, or a `/quit`-style demotion back to the shell. Daintree-initiated
 * teardown has always captured its own id (`gracefulShutdown`); these two
 * boundaries were the gap, so quitting Codex by hand left the session invisible
 * to the resume palette (#12179).
 *
 * Ships the record to Main over the existing `agent-session:captured` event
 * rather than writing the journal here: Main is the journal's single writer,
 * and it owns retention and the exactly-once ledger.
 *
 * Best-effort throughout — every failure mode resolves to one log line and no
 * record. Never logs the captured id itself, which is a resume credential.
 */
export function captureAgentEndSession(args: AgentEndCaptureArgs): void {
  const { terminalId, terminal, agentId, boundary, recentOutput } = args;

  const logOutcome = (outcome: AgentEndCaptureOutcome): void => {
    logger.info("Passive agent session capture outcome", {
      terminalId,
      projectId: terminal.projectId ?? null,
      agentId,
      boundary,
      outcome,
      captured: outcome === "captured" || outcome === "preassigned",
    });
  };

  const resume = getEffectiveAgentConfig(agentId)?.resume;
  if (resume?.kind !== "session-id") {
    logOutcome("no-resume-config");
    return;
  }

  // The id was chosen at launch, so there is nothing to scrape and no
  // false-positive risk (#11782). It still has to belong to THIS agent: a pane
  // that launched one agent and now hosts another carries an id from the
  // previous conversation, and filing it under the wrong agent would resume the
  // wrong thing.
  if (
    terminal.agentSessionId &&
    agentId === terminal.launchAgentId &&
    supportsSessionIdAssignment(agentId)
  ) {
    emitCapture(args, terminal.agentSessionId);
    logOutcome("preassigned");
    return;
  }

  const matcher = createSessionIdMatcher(resume.sessionIdPattern);
  if (!matcher) {
    logOutcome("no-pattern");
    return;
  }

  const match = matcher(recentOutput, {
    occurrence: "last",
    // An exited PTY can deliver nothing further, so its end-of-output is a real
    // token boundary. A demoted pane is still live and still writing.
    boundary: boundary === "exit" ? "eof" : "stream",
    tailLines: CAPTURE_SCAN_LINES,
  });
  if (match.kind !== "match") {
    logOutcome(match.kind === "needs-boundary" ? "needs-boundary" : "no-match");
    return;
  }

  emitCapture(args, match.sessionId);
  logOutcome("captured");
}

function emitCapture(args: AgentEndCaptureArgs, sessionId: string): void {
  const { terminalId, terminal, agentId, boundary } = args;

  // Read every field before the caller's own teardown rewrites the title or
  // clears identity (lesson #5948), and hold `cwd` across the async branch
  // probe so a respawn can't retarget it.
  const cwd = terminal.cwd;
  const record = {
    sessionId,
    agentId,
    worktreeId: terminal.worktreeId ?? null,
    // The observed task title unless the user locked the title, matching every
    // other close path — a locked record should read like the frozen live tab.
    title:
      (terminal.titleMode === "user"
        ? terminal.title
        : (terminal.lastObservedTitle ?? terminal.title)) ?? null,
    projectId: terminal.projectId ?? null,
    // Flags and model describe the agent Daintree launched. A different agent
    // the user started by hand in the same pane must not inherit them.
    ...(agentId === terminal.launchAgentId
      ? { agentLaunchFlags: terminal.agentLaunchFlags, agentModelId: terminal.agentModelId }
      : {}),
    cwd: cwd || undefined,
  };

  // Main's ledger journals at most once per (terminalId, generation), whatever
  // the session id. That is the right key for an exit — one PTY incarnation
  // closes once — and the wrong one for a demotion, where the shell survives and
  // can host several agent runs in the same generation: gating there would let
  // the first `/quit` consume the slot and silently drop every later session,
  // including one a Daintree-initiated close captured. `null` is the journal's
  // explicit fail-open, leaving sessionId dedupe to collapse true duplicates.
  const launchGeneration = boundary === "exit" ? terminal.launchGeneration : null;

  void (async () => {
    // Best-effort branch stamp for resume sanity checks, mirroring the
    // trash-expiry capture: the pty-host has FS access but no WorkspaceClient,
    // and getGitBranch is bounded and never throws.
    const branch = cwd ? await getGitBranch(cwd) : null;
    events.emit("agent-session:captured", {
      terminalId,
      launchGeneration,
      record: { ...record, ...(branch ? { branch } : {}) },
    });
  })();
}
