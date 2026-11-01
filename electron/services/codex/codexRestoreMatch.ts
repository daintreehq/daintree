/**
 * Which Codex thread a restored pane's first prompt names, when it names
 * exactly one (#15269).
 *
 * Restore never guesses (#12434), so this is a filter, not a ranking. A thread
 * is a candidate for a pane only when its first message is the pane's launch
 * prompt exactly, as the CLI received it, and it was created within a fixed
 * interval of that launch. A pane resolves only when it has one candidate,
 * that thread is a candidate for no other pane, and nobody already holds it.
 * Excluded threads still count as candidates: a pane whose prompt fits a held
 * thread and a free one is ambiguous, not answered by elimination.
 */

import { createHash } from "crypto";
import {
  HANDBACK_CODE_TOKEN,
  HANDBACK_INSTRUCTION_TEMPLATES,
} from "../../../shared/types/handback.js";

/**
 * A thread can't predate the launch that opened it. The slack covers the
 * protocol's whole-second timestamps.
 */
export const RESTORE_MATCH_EARLY_SLACK_MS = 5_000;

/**
 * How long after the prompt was recorded the thread may first appear. The
 * prompt is stamped before the PTY spawns, and a fleet launched under memory
 * pressure can take minutes to start. Widening this only adds ambiguity.
 */
export const RESTORE_MATCH_LATE_WINDOW_MS = 10 * 60_000;

export interface RestoreMatchThread {
  sessionId: string;
  createdAtMs: number;
  /** Digests of every launch prompt this thread's first message could have been. */
  promptHashes: readonly string[];
}

export interface RestoreMatchPane {
  key: string;
  promptHash: string;
  at: number;
  resolve: boolean;
}

export function hashPromptText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A handback launch appends one of Daintree's instructions after a blank line,
 * which the single-line launch form turns into two spaces. The same code
 * appears in every marker of an instruction.
 */
const HANDBACK_SUFFIXES = HANDBACK_INSTRUCTION_TEMPLATES.map((template) => {
  const [head, ...rest] = template.split(HANDBACK_CODE_TOKEN).map(escapeRegExp);
  const body = rest.reduce(
    (pattern, part, index) => `${pattern}${index === 0 ? "([a-z0-9]{6})" : "\\1"}${part}`,
    head ?? ""
  );
  return new RegExp(`  ${body}$`);
});

/**
 * The launch prompts a thread's first message is consistent with: the message
 * itself, and for a handback launch, the prompt before the instruction. The
 * pane records the prompt as the caller wrote it, without the instruction.
 */
export function promptHashesForFirstMessage(firstMessage: string): string[] {
  if (firstMessage.length === 0) return [];
  const hashes = [hashPromptText(firstMessage)];
  const handback = HANDBACK_SUFFIXES.map((suffix) => suffix.exec(firstMessage)).find(
    (match) => match !== null
  );
  if (handback) {
    const prompt = firstMessage.slice(0, handback.index).trimEnd();
    if (prompt.length > 0) hashes.push(hashPromptText(prompt));
  }
  return hashes;
}

export interface RestoreMatchScope {
  /** The threads filed under this scope's folder. */
  threads: readonly RestoreMatchThread[];
  panes: readonly RestoreMatchPane[];
}

/**
 * Pair panes with threads where both sides have exactly one candidate. A pane's
 * candidates come only from its own folder (one prompt broadcast to several
 * worktrees is one thread in each), while claimants are counted across every
 * scope, so two spellings of one folder can't each hand out the same thread.
 * The graph is built whole before anything is assigned, so taking one pair can
 * never turn a second ambiguous pane into an answer.
 */
export function matchRestorePanes(
  scopes: readonly RestoreMatchScope[],
  unavailable: ReadonlySet<string>
): Array<{ key: string; sessionId: string }> {
  const candidatesByPane = new Map<RestoreMatchPane, string[]>();
  const claimantCount = new Map<string, number>();
  for (const scope of scopes) {
    for (const pane of scope.panes) {
      const candidates: string[] = [];
      for (const thread of scope.threads) {
        if (!thread.promptHashes.includes(pane.promptHash)) continue;
        if (thread.createdAtMs < pane.at - RESTORE_MATCH_EARLY_SLACK_MS) continue;
        if (thread.createdAtMs > pane.at + RESTORE_MATCH_LATE_WINDOW_MS) continue;
        candidates.push(thread.sessionId);
        claimantCount.set(thread.sessionId, (claimantCount.get(thread.sessionId) ?? 0) + 1);
      }
      candidatesByPane.set(pane, candidates);
    }
  }

  const matches: Array<{ key: string; sessionId: string }> = [];
  for (const [pane, candidates] of candidatesByPane) {
    if (!pane.resolve || candidates.length !== 1) continue;
    const sessionId = candidates[0]!;
    if (claimantCount.get(sessionId) !== 1 || unavailable.has(sessionId)) continue;
    matches.push({ key: pane.key, sessionId });
  }
  return matches;
}
