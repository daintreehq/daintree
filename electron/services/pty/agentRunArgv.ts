import { getEffectiveAgentConfig } from "../../../shared/config/agentRegistry.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { createLogger } from "../../utils/logger.js";
import type { AgentProcessObservation } from "../ProcessDetector.js";
import { events } from "../events.js";
import { readArgvSessionId, typedLineRefutes } from "./argvSessionId.js";
import type { TerminalInfo } from "./types.js";

const logger = createLogger("pty:AgentRunArgv");

/**
 * Ship the conversation a run's own argv resumes to Main, which records it on
 * the saved pane (#15994). Typing `codex resume <id>` into a pane whose Codex
 * quit to the shell starts a run neither capture path can name: live
 * attribution only covers the launched run, and a run that ends mid-turn
 * prints no farewell. The id the process was started with is stated exactly,
 * so recording it guesses nothing.
 *
 * The caller asks once per observed run. Only the pane's launch agent counts:
 * restore relaunches that agent, so another agent's id would resume nothing.
 *
 * `typedLine` is the shell line that started the run, when one was typed. It
 * never supplies an id; it only refuses one. POSIX `ps` drops argument
 * boundaries, so `codex "resume <id>"` — a fresh conversation whose prompt
 * happens to read that way — looks like a resume in argv, and only the typed
 * quoting tells them apart. A line that names the id as a whole argument, or
 * never mentions it (an alias, a script), lets argv stand.
 *
 * Never logs the command line, the typed line or the id.
 */
export function offerAgentRunArgvSession(
  terminalId: string,
  terminal: TerminalInfo,
  observation: AgentProcessObservation,
  typedLine?: string
): void {
  const { agentType } = observation;
  if (terminal.isAssistantTerminal === true || agentType !== terminal.launchAgentId) return;
  const generation = terminal.launchGeneration;
  const projectId = terminal.projectId;
  if (typeof generation !== "number" || !projectId) return;
  const config = getEffectiveAgentConfig(agentType);
  if (!config?.resumeArgv) return;

  const argvId = readArgvSessionId(observation.command, config.command, config.resumeArgv);
  const refuted =
    argvId !== null &&
    typedLine !== undefined &&
    typedLineRefutes(typedLine, config.command, config.resumeArgv, argvId);
  const sessionId = refuted ? null : argvId;
  const run = { launchGeneration: generation, agentIncarnation: terminal.agentIncarnation };
  logger.info("Agent run argv read", {
    terminalId,
    projectId,
    agentId: agentType,
    generation,
    incarnation: run.agentIncarnation,
    named: argvId !== null,
    refuted,
  });
  if (!sessionId) return;

  try {
    events.emit("agent-session:observed", {
      terminalId,
      agentId: agentType,
      projectId,
      sessionId,
      run,
    });
  } catch (error) {
    logger.warn("Agent run argv session failed to ship", {
      terminalId,
      error: formatErrorMessage(error, "observed-session emit threw")
        .split(sessionId)
        .join("[session]"),
    });
  }
}
