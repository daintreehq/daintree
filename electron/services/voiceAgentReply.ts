import { logDebug } from "../utils/logger.js";
import { handleTerminalReadLastMessageOwned } from "./mcp-server/terminalLastMessage.js";
import type { PtyClient } from "./PtyClient.js";
import { MAX_CORRECTION_REPLY_CHARS, type VoiceAgentReply } from "./voiceAgentReplyTypes.js";
import { readTerminalLines } from "./voiceContextKeyterms.js";

export type { VoiceAgentReply, VoiceObservedAgentState } from "./voiceAgentReplyTypes.js";

const P = "[VoiceAgentReply]";

// Read wider than the bound, so redaction sees whole lines before the cut.
const REPLY_READ_BYTES = 8 * 1024;

/**
 * A reply's text ready to send: credential-shaped lines emptied, blank runs
 * folded, then the newest characters kept within the bound, starting at a
 * word. A head the transcript read already cut loses its first paragraph,
 * since the cut may have taken the name that marks a credential below it.
 * Null when nothing readable is left.
 */
export function boundAgentReply(
  text: string,
  headCut = false
): { text: string; cut: boolean } | null {
  let lines = text.split(/\r?\n/);
  if (headCut) {
    const end = lines.findIndex((line, index) => index > 0 && line.trim() === "");
    lines = end < 0 ? lines.slice(1) : lines.slice(end + 1);
  }
  const kept: string[] = [];
  for (const raw of readTerminalLines(lines, true)) {
    const line = raw.trimEnd();
    if (line === "" && (kept.length === 0 || kept[kept.length - 1] === "")) continue;
    kept.push(line);
  }
  const whole = kept.join("\n").trim();
  if (whole === "") return null;
  if (whole.length <= MAX_CORRECTION_REPLY_CHARS) return { text: whole, cut: false };
  const tail = whole.slice(-MAX_CORRECTION_REPLY_CHARS);
  const wordStart = tail.search(/\s/);
  const bounded = (wordStart < 0 ? tail : tail.slice(wordStart)).trim();
  return bounded === "" ? null : { text: bounded, cut: true };
}

function stamp(at: number | null | undefined): number | null {
  return typeof at === "number" && Number.isFinite(at) && at > 0 ? at : null;
}

// Settles with `fallback` at the deadline, or if the read fails.
async function byDeadline<T>(read: Promise<T>, fallback: T, deadline: Promise<void>): Promise<T> {
  return Promise.race([read.catch(() => fallback), deadline.then(() => fallback)]);
}

/**
 * The dictated agent's last reply from its transcript, with the state Daintree
 * observed for its terminal, ready to send with the cleanup request. Only a
 * reply the transcript can vouch for comes back: another agent, a store that
 * was never certain, no reply on record, or a read slower than `budgetMs`
 * yields null, and cleanup goes without it. A state read that fails or runs
 * out sends the reply without one. The caller has already decided the
 * terminal may be read.
 */
export async function readAgentReplyForCorrection(
  ptyClient: PtyClient | undefined,
  terminalId: string | undefined,
  budgetMs: number
): Promise<VoiceAgentReply | null> {
  if (!ptyClient || !terminalId) return null;
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve();
    }, budgetMs);
    timer.unref();
  });
  try {
    const [result, info] = await Promise.all([
      byDeadline(
        handleTerminalReadLastMessageOwned(
          terminalId,
          { maxBytes: REPLY_READ_BYTES },
          controller.signal
        ),
        null,
        deadline
      ),
      // The state query can't be cancelled; one past the deadline is ignored.
      byDeadline(ptyClient.getTerminalAsync(terminalId), null, deadline),
    ]);
    if (result?.status !== "ok" || !result.message) return null;
    const bounded = boundAgentReply(result.message.text, result.message.truncated);
    if (!bounded) return null;
    const state = info?.agentState;
    return {
      text: bounded.text,
      truncated: result.message.truncated || bounded.cut,
      recordedAt: stamp(result.message.recordedAt),
      newerRecordsFollow: result.newerRecordsFollow,
      ...(state
        ? {
            observedState: {
              state,
              ...(info.waitingReason ? { waitingReason: info.waitingReason } : {}),
              lastStateChangeAt: stamp(info.lastStateChange),
            },
          }
        : {}),
    };
  } catch {
    logDebug(`${P} Reply read failed`);
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
