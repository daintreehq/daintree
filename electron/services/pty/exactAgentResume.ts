/**
 * Whether a terminal's agent would come back to this exact conversation if it
 * were torn down now (#13848): reopened by a session id it already holds, with
 * a transcript for that id on disk. Asked before any teardown, because for most
 * agents the id only exists once the process is gone.
 *
 * Only an agent Daintree assigns the id to at launch can answer before the
 * kill, and only one whose transcript store main can read for that pane. Today
 * that is Claude. Everything else — another resume kind, an id still scraped at
 * teardown, a store that isn't certain, a lookup that couldn't decide — is a
 * no, with the reason it was refused.
 *
 * Each answer is one observation at one moment and is never kept: a first
 * message can create the transcript right after a `no-transcript`, and the
 * CLI's own retention can remove one after a yes. It says nothing about whether
 * interrupting the agent is a good idea; that stays the caller's call.
 */

import { getEffectiveAgentConfig, type AgentResume } from "../../../shared/config/agentRegistry.js";
import { supportsSessionIdAssignment } from "../../../shared/types/agentSettings.js";
import type { PtyClient } from "../PtyClient.js";
import {
  getClaudePaneProjectsRoot,
  observeClaudeTranscript,
  type ClaudeTranscriptObservation,
} from "../claude/ClaudeSessionStore.js";

type TerminalInfo = Awaited<ReturnType<PtyClient["getAllTerminalsAsync"]>>[number];

export type ExactResumeTerminal = Pick<
  TerminalInfo,
  | "id"
  | "cwd"
  | "launchAgentId"
  | "detectedAgentId"
  | "agentSessionId"
  | "agentIncarnation"
  | "hasPty"
  | "isExited"
>;

/**
 * Why the answer is no, in the order the checks run:
 * - `no-agent`: the terminal wasn't launched as an agent.
 * - `unknown-agent`: its launch agent isn't in the registry.
 * - `resume-not-exact`: the agent reopens by history, project or name, or not at all.
 * - `id-not-assigned-at-launch`: the agent's id is only scraped at teardown.
 * - `no-session-id`: the terminal holds no id.
 * - `session-identity-unknown`: the id can't be tied to what runs now — another
 *   agent is detected, a relaunch was observed in the PTY, or the PTY isn't live.
 * - `transcript-check-unsupported`: main has no way to look for this agent's transcript.
 * - `store-unknown`: which store this pane reads isn't certain.
 * - `no-transcript`: the store was read and has no transcript for the id.
 * - `transcript-unknown`: the lookup couldn't decide either way.
 */
export type ExactResumeRefusal =
  | "no-agent"
  | "unknown-agent"
  | "resume-not-exact"
  | "id-not-assigned-at-launch"
  | "no-session-id"
  | "session-identity-unknown"
  | "transcript-check-unsupported"
  | "store-unknown"
  | "no-transcript"
  | "transcript-unknown";

export type ExactResumeVerdict =
  | { resumesExactly: true }
  | {
      resumesExactly: false;
      reason: ExactResumeRefusal;
      /** Set with `resume-not-exact`; `none` when the agent declares no resume. */
      resumeKind?: Exclude<AgentResume["kind"], "session-id"> | "none";
    };

export interface ExactResumeObservation {
  terminalId: string;
  verdict: ExactResumeVerdict;
}

export interface TranscriptChecker {
  /** The store this pane was launched against, or null unless that is certain. */
  projectsRoot(terminalId: string): string | null;
  observe(
    sessionId: string,
    cwd: string | undefined,
    projectsRoot: string
  ): Promise<ClaudeTranscriptObservation>;
}

const TRANSCRIPT_CHECKERS: Readonly<Record<string, TranscriptChecker>> = {
  claude: {
    projectsRoot: getClaudePaneProjectsRoot,
    observe: (sessionId, cwd, projectsRoot) =>
      observeClaudeTranscript(sessionId, cwd, projectsRoot),
  },
};

export interface ExactResumeDependencies {
  checkers?: Readonly<Record<string, TranscriptChecker>>;
}

function refuse(reason: ExactResumeRefusal): ExactResumeVerdict {
  return { resumesExactly: false, reason };
}

/**
 * The id was minted for the agent this terminal launched, so it only names the
 * running conversation while that same launch is still the one running: no
 * other agent detected, no relaunch observed in the PTY (an unobserved count is
 * not zero), and a live process.
 */
function holdsLaunchSession(terminal: ExactResumeTerminal): boolean {
  if (terminal.detectedAgentId && terminal.detectedAgentId !== terminal.launchAgentId) {
    return false;
  }
  return terminal.agentIncarnation === 0 && terminal.hasPty === true && terminal.isExited !== true;
}

export async function observeExactAgentResume(
  terminal: ExactResumeTerminal,
  dependencies: ExactResumeDependencies = {}
): Promise<ExactResumeVerdict> {
  const agentId = terminal.launchAgentId;
  if (!agentId) return refuse("no-agent");
  const config = getEffectiveAgentConfig(agentId);
  if (!config) return refuse("unknown-agent");
  const resume = config.resume;
  if (resume?.kind !== "session-id") {
    return {
      resumesExactly: false,
      reason: "resume-not-exact",
      resumeKind: resume?.kind ?? "none",
    };
  }
  if (!supportsSessionIdAssignment(agentId)) return refuse("id-not-assigned-at-launch");
  const sessionId = terminal.agentSessionId;
  if (!sessionId) return refuse("no-session-id");
  if (!holdsLaunchSession(terminal)) return refuse("session-identity-unknown");

  const checkers = dependencies.checkers ?? TRANSCRIPT_CHECKERS;
  if (!Object.hasOwn(checkers, agentId)) return refuse("transcript-check-unsupported");
  const checker = checkers[agentId];
  const projectsRoot = checker.projectsRoot(terminal.id);
  if (!projectsRoot) return refuse("store-unknown");

  let observation: ClaudeTranscriptObservation;
  try {
    observation = await checker.observe(sessionId, terminal.cwd || undefined, projectsRoot);
  } catch {
    return refuse("transcript-unknown");
  }
  if (observation === "present") return { resumesExactly: true };
  return refuse(observation === "missing" ? "no-transcript" : "transcript-unknown");
}

/**
 * One observation per terminal, in the order given. Lookups run together and
 * share the reader's own per-store scan and deadline, so a batch costs about
 * as long as its slowest terminal.
 */
export async function observeExactAgentResumes(
  terminals: readonly ExactResumeTerminal[],
  dependencies: ExactResumeDependencies = {}
): Promise<ExactResumeObservation[]> {
  return Promise.all(
    terminals.map(async (terminal) => ({
      terminalId: terminal.id,
      verdict: await observeExactAgentResume(terminal, dependencies).catch(() =>
        refuse("transcript-unknown")
      ),
    }))
  );
}
