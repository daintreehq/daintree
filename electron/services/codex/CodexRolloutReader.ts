/**
 * How much context a Codex pane carries, read from the rollout its own Codex
 * holds open (#16408).
 *
 * After each response, and again right after compacting, Codex appends an
 * `event_msg` whose payload is a `token_count`. Its
 * `info.last_token_usage.total_tokens` is the figure Codex measures its context
 * by, and `info.model_context_window` the window Codex works to, when the
 * record states one. None of it is contracted, so the newest count in a shape
 * this doesn't recognise answers that, rather than an older count standing in.
 *
 * One file is opened for reading, through a descriptor checked to hold the
 * same file the probe saw the pane's Codex writing, and closed. Nothing is
 * written, moved or kept.
 */

import { constants as fsConstants, type BigIntStats } from "fs";
import { lstat, open, type FileHandle } from "fs/promises";
import type {
  AgentContextUsageResult,
  AgentContextUsageUnavailableReason,
} from "../../../shared/types/ipc/agentContextUsage.js";
import { linesFromEnd, type ScanState } from "../sessionFileTail.js";
import type { CodexRolloutIdentity } from "./CodexSessionFileProbe.js";

/** Bytes read per step back. The newest count is normally a few records from the end. */
const USAGE_CHUNK_BYTES = 64 * 1024;
/**
 * The ceiling: room for a compaction's replacement history or one large tool
 * output after the newest count, and no more, since this runs once per turn
 * per pane on rollouts that grow to tens of MB.
 */
const USAGE_MAX_SCAN_BYTES = 2 * 1024 * 1024;

export interface CodexContextUsageOptions {
  signal?: AbortSignal;
  chunkBytes?: number;
  maxScanBytes?: number;
}

type RolloutRecord =
  | { kind: "usage"; contextTokens: number; contextWindow?: number; recordedAt: number }
  | { kind: "no-usage" }
  | { kind: "compaction" }
  | { kind: "unrecognized" };

const UNRECOGNIZED: RolloutRecord = { kind: "unrecognized" };

/** The counts every `last_token_usage` Codex has written carries. */
const USAGE_PARTS = [
  "input_tokens",
  "cached_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/**
 * What one rollout line says about the context, or null for a line that says
 * nothing about it. A line that won't parse could have been a count, so it
 * answers as one this doesn't recognise.
 */
export function parseRolloutRecord(line: string): RolloutRecord | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return UNRECOGNIZED;
  }
  if (!isRecord(parsed)) return UNRECOGNIZED;
  // Whatever was counted before it is no longer the context.
  if (parsed.type === "compacted") return { kind: "compaction" };
  if (parsed.type !== "event_msg") return null;
  const payload = parsed.payload;
  if (!isRecord(payload)) return UNRECOGNIZED;
  if (payload.type !== "token_count") return null;

  const info = payload.info;
  // Codex had no usage to report yet.
  if (info === null) return { kind: "no-usage" };
  if (!isRecord(info)) return UNRECOGNIZED;
  const last = info.last_token_usage;
  if (!isRecord(last)) return UNRECOGNIZED;
  const total = tokenCount(last.total_tokens);
  const parts = USAGE_PARTS.map((key) => tokenCount(last[key]));
  // Absent from rollouts written before Codex added it.
  const cacheWrite =
    last.cache_write_input_tokens === undefined ? 0 : tokenCount(last.cache_write_input_tokens);
  if (total === undefined || cacheWrite === undefined || parts.includes(undefined)) {
    return UNRECOGNIZED;
  }
  // Every part zero is Codex's own estimate of its history after a compaction,
  // which it writes with the reasoning flag set. Filling the count to the
  // window after an overflow writes the same shape without it, and that total
  // is only the step up to the window, not the context.
  if (
    cacheWrite === 0 &&
    parts.every((part) => part === 0) &&
    info.last_usage_includes_reasoning !== true
  ) {
    return UNRECOGNIZED;
  }

  const window = info.model_context_window;
  let contextWindow: number | undefined;
  if (window !== undefined && window !== null) {
    if (typeof window !== "number" || !Number.isSafeInteger(window) || window <= 0) {
      return UNRECOGNIZED;
    }
    contextWindow = window;
  }
  const recordedAt = typeof parsed.timestamp === "string" ? Date.parse(parsed.timestamp) : NaN;
  if (!Number.isFinite(recordedAt)) return UNRECOGNIZED;
  return {
    kind: "usage",
    contextTokens: total,
    recordedAt,
    ...(contextWindow === undefined ? {} : { contextWindow }),
  };
}

function unavailable(reason: AgentContextUsageUnavailableReason): AgentContextUsageResult {
  return { status: "unavailable", reason };
}

function isAbsence(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** `lsof` prints a device as hex and an inode as decimal; both are compared without rounding. */
function sameIdentity(stats: BigIntStats, rollout: CodexRolloutIdentity): boolean {
  if (!/^0x[0-9a-f]+$/i.test(rollout.device) || !/^\d+$/.test(rollout.inode)) return false;
  return stats.dev === BigInt(rollout.device) && stats.ino === BigInt(rollout.inode);
}

/**
 * The rollout through one descriptor that holds the file the probe saw, or null.
 * `lstat` refuses a symlink or a replacement at the path, `O_NOFOLLOW` and
 * `O_NONBLOCK` keep a leaf swapped in between from carrying the open elsewhere
 * or holding it on a FIFO, and the descriptor is checked again once open.
 */
async function openObserved(
  rollout: CodexRolloutIdentity
): Promise<{ handle: FileHandle; size: number } | null> {
  const checked = await lstat(rollout.path, { bigint: true });
  if (!checked.isFile() || !sameIdentity(checked, rollout)) return null;
  const handle = await open(
    rollout.path,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0)
  );
  try {
    // Windows has no O_NOFOLLOW. Refuse a leaf replaced by a link before any
    // reads, even when that link leads back to the observed file.
    if (!fsConstants.O_NOFOLLOW) {
      const current = await lstat(rollout.path, { bigint: true });
      if (!current.isFile() || !sameIdentity(current, rollout)) {
        await handle.close();
        return null;
      }
    }
    const stats = await handle.stat({ bigint: true });
    if (stats.isFile() && sameIdentity(stats, rollout)) {
      return { handle, size: Number(stats.size) };
    }
  } catch {
    // Opened and then not verifiable: not a file this reads.
  }
  await handle.close();
  return null;
}

/**
 * The context the rollout's newest token count records, read newest first
 * from its end. A compaction or a count with no usage yet, with no count since,
 * answers that there is none; a line still being written answers that it
 * wasn't recognised, since it is newer than anything before it.
 */
export async function readCodexContextUsage(
  rollout: CodexRolloutIdentity,
  options: CodexContextUsageOptions = {}
): Promise<AgentContextUsageResult> {
  const { signal } = options;
  let handle: FileHandle | null = null;
  try {
    signal?.throwIfAborted();
    const opened = await openObserved(rollout);
    if (!opened) return unavailable("rollout-unknown");
    handle = opened.handle;

    const state: ScanState = { partialTail: false, capReached: false };
    for await (const bytes of linesFromEnd(handle, opened.size, state, {
      chunkBytes: options.chunkBytes ?? USAGE_CHUNK_BYTES,
      maxScanBytes: options.maxScanBytes ?? USAGE_MAX_SCAN_BYTES,
      signal,
    })) {
      if (state.partialTail) return unavailable("unrecognized");
      const record = parseRolloutRecord(bytes.toString("utf8"));
      if (!record) continue;
      switch (record.kind) {
        case "compaction":
        case "no-usage":
          return unavailable("no-request");
        case "unrecognized":
          return unavailable("unrecognized");
        case "usage": {
          const { contextTokens, contextWindow, recordedAt } = record;
          return {
            status: "ok",
            provider: "codex",
            contextTokens,
            recordedAt,
            ...(contextWindow === undefined ? {} : { contextWindow }),
          };
        }
      }
    }
    if (state.partialTail) return unavailable("unrecognized");
    return unavailable(state.capReached ? "search-cap-reached" : "no-request");
  } catch (error) {
    if (signal?.aborted) throw error;
    if (isAbsence(error)) return unavailable("rollout-unknown");
    return unavailable("store-unreadable");
  } finally {
    await handle?.close();
  }
}
