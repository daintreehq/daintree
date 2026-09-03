import { getEffectiveAgentConfig } from "../../../shared/config/agentRegistry.js";
import { supportsSessionIdAssignment } from "../../../shared/types/agentSettings.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { getGitBranch } from "../../utils/gitUtils.js";
import { createLogger } from "../../utils/logger.js";
import { events } from "../events.js";
import { createSessionIdMatcher } from "./sessionIdCapture.js";
import type { TerminalInfo } from "./types.js";

const logger = createLogger("pty:AgentEndCapture");

/**
 * Non-blank trailing ROWS of rendered output the passive scrape will trust.
 *
 * Taking the last match is not enough on its own: with no real hint printed, the
 * last match would be whatever `codex resume <id>` text the conversation
 * happened to contain. The window is what makes the scrape mean "the agent's
 * farewell", and it has to be measured in rendered rows — the raw PTY tail is
 * useless for this, because `stripAnsiCodes` deletes cursor-positioning escapes
 * with no replacement and a ratatui repaint collapses into one giant line.
 *
 * Eight rows, not the four `IdentityWatcher` uses for prompt-return
 * (`SHELL_IDENTITY_FALLBACK_SCAN_LINES`): that scan only has to reach the prompt
 * itself, while this one has to reach PAST the prompt to the hint printed before
 * it. A direnv banner plus a two-line powerlevel10k prompt is four rows on its
 * own. Blank rows are free, so trailing viewport padding costs nothing.
 */
export const CAPTURE_SCAN_ROWS = 8;

/**
 * The same window expressed in characters, applied alongside the row budget.
 *
 * The row budget alone is not enough, because the scrape cannot count on the
 * text having real line breaks: `stripAnsiCodes` deletes cursor-positioning
 * escapes with no replacement, so a ratatui repaint arrives as one enormous
 * line and a row budget over it bounds nothing. What a farewell hint always is,
 * whatever the line structure, is CLOSE TO THE END — everything legitimately
 * printed after it (alt-screen restore, a direnv banner, a multi-line prompt)
 * runs to a few hundred characters at most.
 */
const CAPTURE_SCAN_CHARS = 400;

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
  /**
   * Tail of the headless mirror's RENDERED rows — alt-screen, cursor moves and
   * erases already resolved into real lines. The scrape's preferred input.
   */
  renderedLines: string[];
  /**
   * Raw forensic tail, snapshotted before any teardown that would clear it.
   * Fallback only: `kill()` tears the mirror down, so a graceful teardown that
   * failed to capture leaves this as the sole surviving evidence. The row window
   * degrades to roughly the whole tail here, which is what the graceful scrape
   * itself does.
   */
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
  const { terminalId, terminal, agentId, boundary, renderedLines, recentOutput } = args;

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

  // An exited PTY can deliver nothing further, so its end-of-output is a real
  // token boundary. A demoted pane is still live and still writing.
  const scan = (text: string) =>
    matcher(text, {
      occurrence: "last",
      boundary: boundary === "exit" ? "eof" : "stream",
      tailLines: CAPTURE_SCAN_ROWS,
      tailChars: CAPTURE_SCAN_CHARS,
    });

  // Rendered rows first: alt-screen, cursor moves and erases are already
  // resolved there, so the row budget means what it says. The mirror is not
  // guaranteed to be current though — xterm parses asynchronously and an exit
  // fires in the same breath as the final chunk, and in worker mode the rows
  // arrive on this thread only as a pushed cache — so the raw tail stays as the
  // fallback. The character budget is what keeps that fallback honest.
  let match = scan(renderedLines.join("\n"));
  if (match.kind !== "match") {
    match = scan(recentOutput);
  }
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
    try {
      // Best-effort branch stamp for resume sanity checks, mirroring the
      // trash-expiry capture: the pty-host has FS access but no WorkspaceClient,
      // and getGitBranch is bounded and never throws.
      const branch = cwd ? await getGitBranch(cwd) : null;
      events.emit("agent-session:captured", {
        terminalId,
        launchGeneration,
        record: { ...record, ...(branch ? { branch } : {}) },
      });
    } catch (error) {
      // `events.emit` fans out synchronously with no per-listener guard, so a
      // throwing subscriber lands here as an unhandled rejection — which the
      // pty-host turns into process.exit(1), taking every terminal on the shard
      // with it. Losing one resume record is the cheaper failure.
      logger.warn("Passive agent session capture failed to ship its record", {
        terminalId,
        agentId,
        boundary,
        error: formatErrorMessage(error, "capture emit threw a non-Error"),
      });
    }
  })();
}
