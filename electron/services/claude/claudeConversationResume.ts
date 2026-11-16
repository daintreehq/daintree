/**
 * Reopening a Claude conversation from the config folder it was written under,
 * when the launch runs on another one (#17087).
 *
 * Claude Code looks a `--resume <id>` up only in the folder it runs on, and an
 * account switch moves the pane to another account's folder while the
 * conversation stays where it began. `--resume` also takes the transcript's
 * path, and the CLI then appends to that file wherever it is, so nothing is
 * copied, linked or written into either folder. The path is found, never
 * built: the project folder's name is the CLI's to derive, and a long one is
 * truncated and hashed.
 *
 * A miss of any kind leaves the resume by id as it was, and the CLI's own
 * refusal is what the pane then shows.
 */

import path from "path";
import {
  exactResumeSessionId,
  resumeByTranscriptPath,
} from "../../../shared/types/agentSettings.js";
import type { ConversationStore } from "../../../shared/types/panel.js";
import { locateClaudeTranscript } from "./ClaudeSessionReader.js";
import { CLAUDE_TRANSCRIPT_LOOKUP_TIMEOUT_MS } from "./ClaudeSessionStore.js";

const CLAUDE_AGENT_ID = "claude";

export interface ClaudeConversationResumeOptions {
  timeoutMs?: number;
  locate?: typeof locateClaudeTranscript;
}

/**
 * `command` with its resume of `store.sessionId` pointed at that conversation's
 * transcript in `store.configDir`, or undefined when the command resumes some
 * other conversation, the transcript isn't found there in time, or isn't one
 * the reader trusts.
 */
export async function resumeClaudeFromConversationStore(
  command: string,
  store: ConversationStore,
  cwd: string,
  options: ClaudeConversationResumeOptions = {}
): Promise<string | undefined> {
  if (exactResumeSessionId(command, CLAUDE_AGENT_ID) !== store.sessionId) return undefined;
  if (!path.isAbsolute(store.configDir) || !path.isAbsolute(cwd)) return undefined;

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(undefined);
    }, options.timeoutMs ?? CLAUDE_TRANSCRIPT_LOOKUP_TIMEOUT_MS);
  });
  const lookup = (options.locate ?? locateClaudeTranscript)(
    {
      projectsRoot: path.join(store.configDir, "projects"),
      cwd,
      sessionId: store.sessionId,
    },
    controller.signal
  ).catch(() => undefined);
  try {
    const located = await Promise.race([lookup, expiry]);
    if (located?.status !== "found") return undefined;
    return resumeByTranscriptPath(command, CLAUDE_AGENT_ID, store.sessionId, located.file);
  } finally {
    clearTimeout(timer);
  }
}
