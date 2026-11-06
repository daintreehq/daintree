import { HandoffCollector, type QuotedTurn } from "./handoff.js";
import type { IndexStore } from "./indexStore.js";
import { openSessionSnapshot, readJsonlLines } from "./jsonlLines.js";
import { parseRecord, type SessionAgentId } from "./sessionRecords.js";

/**
 * A record past this is skipped rather than parsed: `JSON.parse` would hold
 * the whole line and its object graph at once. Real records past it are
 * pasted images and giant tool payloads.
 */
export const MAX_RECORD_BYTES = 8 * 1024 * 1024;

export interface ConvertInput {
  readonly id: string;
  readonly agentId: SessionAgentId;
  readonly sessionId: string;
  readonly path: string;
  readonly signal: AbortSignal;
  readonly onProgress: (fraction: number) => void;
}

export interface ConvertResult {
  readonly sourceBytes: number;
  readonly fragments: number;
  readonly skippedLines: number;
  readonly prompts: readonly QuotedTurn[];
  readonly lastReply: QuotedTurn | null;
}

export class SessionMismatchError extends Error {}

/**
 * Reads the session once, from its first byte to its size at open, and builds
 * the index and the hand-off in the same pass. The file is opened read-only
 * and nothing is written next to it; the index is only moved into place once
 * the whole snapshot is in it.
 */
export async function convertSession(
  store: IndexStore,
  input: ConvertInput
): Promise<ConvertResult> {
  const snapshot = await openSessionSnapshot(input.path);
  const builder = await store.createBuilder(input.id).catch(async (error: unknown) => {
    await snapshot.handle.close();
    throw error;
  });
  const handoff = new HandoffCollector();
  let skippedLines = 0;
  let namedSelf = false;
  let firstSessionId: string | null = null;
  let lastReport = 0;

  try {
    for await (const line of readJsonlLines(snapshot, {
      maxLineBytes: MAX_RECORD_BYTES,
      signal: input.signal,
    })) {
      const parsed = line.text === null ? null : parseRecord(input.agentId, line.text);
      if (!parsed) {
        skippedLines += 1;
        continue;
      }
      if (parsed.sessionId) {
        firstSessionId ??= parsed.sessionId;
        if (parsed.sessionId === input.sessionId) namedSelf = true;
      }
      if (parsed.sidechain) continue;
      for (const fragment of parsed.fragments) {
        builder.add(fragment.kind, fragment.text, {
          line: line.line,
          byteOffset: line.byteOffset,
          timestamp: parsed.timestamp,
        });
        handoff.add(fragment, line.line, parsed.timestamp);
      }
      if (line.byteOffset - lastReport > 4 * 1024 * 1024) {
        lastReport = line.byteOffset;
        input.onProgress(snapshot.bytes > 0 ? line.byteOffset / snapshot.bytes : 1);
      }
    }
    // The core lookup verified the file; this checks it again at open, since
    // the path is a moment's observation. A rollout opens with the session's
    // own meta, and a Claude Code transcript names its session on its records.
    const verified = input.agentId === "codex" ? firstSessionId === input.sessionId : namedSelf;
    if (!verified) {
      throw new SessionMismatchError(
        "The session file no longer belongs to this pane's session, so nothing was converted."
      );
    }
    // The last read can finish after a cancel; the index is not published then.
    input.signal.throwIfAborted();
    await builder.finish();
  } catch (error) {
    await builder.abandon();
    throw error;
  } finally {
    await snapshot.handle.close();
  }

  return {
    sourceBytes: snapshot.bytes,
    fragments: builder.fragments,
    skippedLines,
    prompts: handoff.recentPrompts(),
    lastReply: handoff.lastReply(),
  };
}
