/**
 * Reads the subagents a live Claude Code terminal spawned.
 *
 * Attribution is the easy half here, and that is the one place this is simpler
 * than the Codex side. Daintree mints the Claude session id at launch and
 * passes it in with `--session-id` (`shared/config/agents/claude.ts`), so the
 * parent is an exact lookup — no cwd-and-recency correlation, no ambiguity to
 * refuse. Reading the store is the hard half; see `ClaudeSubagentReader` for
 * the #4100 boundary this sits on and what is actually on disk.
 *
 * The store is the one the pane was launched against, read off its host
 * record: an account pane writes under the account's folder, not Daintree's
 * own `~/.claude` (#16269). Because the session id is exact, looking there is
 * no guess either.
 */

import path from "path";
import { getPtyClient } from "../../window/serviceRefs.js";
import { subagentTerminalAgentId } from "../subagentTerminalAgent.js";
import { scrubSecrets } from "../../../shared/utils/secretScrubber.js";
import { sanitizePath } from "../../utils/pathScrubber.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import {
  findSubagentsDir,
  isSafeSubagentId,
  listSubagentsInDir,
  readTranscriptFile,
} from "./ClaudeSubagentReader.js";
import type {
  AgentSubagentUnavailableReason,
  AgentSubagentsResult,
  AgentSubagentTranscriptResult,
} from "../../../shared/types/ipc/agentSubagents.js";

function unavailable(
  reason: AgentSubagentUnavailableReason,
  detail?: string
): { status: "unavailable"; reason: AgentSubagentUnavailableReason; detail?: string } {
  // A filesystem error message names the file it failed on, and that path is
  // the user's home. Scrubbed for both, since only one of the two utilities
  // knows about paths and only the other knows about secrets.
  return detail
    ? { status: "unavailable", reason, detail: sanitizePath(scrubSecrets(detail)) }
    : { status: "unavailable", reason };
}

export interface ResolvedTerminal {
  cwd: string;
  parentSessionId: string;
  /** The Claude store the pane's launch env names; absent when it couldn't be resolved. */
  configDir?: string;
}

/**
 * Read the terminal's identity from the pty-host record rather than trusting
 * the renderer. The renderer supplies only a terminal id, so a compromised or
 * buggy caller cannot point this at another folder's Claude history — the cwd,
 * the session id and the store all come from the host.
 */
export async function resolveClaudeTerminal(terminalId: string): Promise<
  | ResolvedTerminal
  | {
      status: "unavailable";
      reason: Extract<
        AgentSubagentUnavailableReason,
        "terminal-unknown" | "provider-mismatch" | "no-session"
      >;
    }
> {
  const info = await getPtyClient()?.getTerminalAsync(terminalId);
  if (!info) return { status: "unavailable", reason: "terminal-unknown" };
  // An exited agent answers for nothing, even though the record still holds
  // its launch hint and session id.
  if (subagentTerminalAgentId(info) !== "claude") {
    return { status: "unavailable", reason: "provider-mismatch" };
  }
  if (!info.cwd || !path.isAbsolute(info.cwd)) {
    return { status: "unavailable", reason: "terminal-unknown" };
  }
  // A pane launched before #11782, or one restored without its id, has no
  // addressable parent. Nothing to correlate against, so say so.
  if (!info.agentSessionId) return { status: "unavailable", reason: "no-session" };
  return {
    cwd: info.cwd,
    parentSessionId: info.agentSessionId,
    ...(info.claudeConfigDir !== undefined && { configDir: info.claudeConfigDir }),
  };
}

export async function listClaudeSubagents(terminalId: string): Promise<AgentSubagentsResult> {
  const resolved = await resolveClaudeTerminal(terminalId);
  if ("status" in resolved) return resolved;
  // Daintree's own store is no stand-in: an empty list from the wrong store
  // looks exactly like a session that never delegated.
  const configDir = resolved.configDir;
  if (!configDir) return unavailable("store-unknown");

  try {
    const dir = await findSubagentsDir(resolved.cwd, resolved.parentSessionId, { configDir });
    return {
      status: "ok",
      provider: "claude",
      parentId: resolved.parentSessionId,
      // A session that has not delegated anything yet has no directory at all.
      // That is an empty list, not a failure — the chip renders nothing either way.
      subagents: dir ? await listSubagentsInDir(dir) : [],
    };
  } catch (error) {
    return unavailable("store-unreadable", formatErrorMessage(error, "Claude store read failed"));
  }
}

export async function readClaudeSubagentTranscript(
  terminalId: string,
  subagentId: string
): Promise<AgentSubagentTranscriptResult> {
  const resolved = await resolveClaudeTerminal(terminalId);
  if ("status" in resolved) return resolved;
  // The id becomes a filename, so it is checked before it is joined rather than
  // after: a traversal-shaped id must never reach `path.join` at all.
  if (!isSafeSubagentId(subagentId)) return unavailable("subagent-not-found");
  const configDir = resolved.configDir;
  if (!configDir) return unavailable("store-unknown");

  try {
    const dir = await findSubagentsDir(resolved.cwd, resolved.parentSessionId, { configDir });
    if (!dir) return unavailable("no-session");

    // Membership check before the read. The renderer names a child id, and
    // without this a wrong or hostile id would read a transcript belonging to
    // some other terminal's session.
    const children = await listSubagentsInDir(dir);
    if (!children.some((child) => child.id === subagentId)) {
      return unavailable("subagent-not-found");
    }

    const { messages, truncated } = await readTranscriptFile(
      path.join(dir, `agent-${subagentId}.jsonl`)
    );
    return { status: "ok", subagentId, messages, truncated };
  } catch (error) {
    return unavailable("store-unreadable", formatErrorMessage(error, "Claude store read failed"));
  }
}
