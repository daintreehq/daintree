import type { IpcEnvelope } from "../../../shared/types/ipc/errors.js";
import { toSnapshotContinuation } from "../../../shared/types/terminal.js";
import { CHANNELS } from "../../ipc/channels.js";

/**
 * A live snapshot's continuation (#12791) is safe to replay only while the
 * output after it carries stream offsets, so the restore can fence off what
 * the snapshot already holds; otherwise a chunk painted again can complete
 * the escape tail into a sequence nobody sent. A remote view's output comes
 * over its host's terminal stream, which carries those offsets only from a
 * host that forwards them (#13916), while every host since #12791 answers a
 * snapshot read with a continuation. The continuation alone proves nothing,
 * so a host that forwards offsets vouches for each snapshot it answers a
 * remote view with (`remoteStreamOffsets`, set by the terminal snapshot
 * handlers), and the Shell keeps a forwarded continuation only then.
 */

/** What a forwarded snapshot read may hand the view that asked. */
export function acceptForwardedSnapshots(channel: string, envelope: IpcEnvelope): IpcEnvelope {
  if (!envelope.ok) return envelope;
  if (channel === CHANNELS.TERMINAL_GET_SERIALIZED_STATE) {
    return { ...envelope, data: acceptSnapshot(envelope.data) };
  }
  if (channel === CHANNELS.TERMINAL_GET_SERIALIZED_STATES) {
    const states = envelope.data;
    if (typeof states !== "object" || states === null) return envelope;
    return {
      ...envelope,
      data: Object.fromEntries(
        Object.entries(states).map(([id, state]) => [id, acceptSnapshot(state)])
      ),
    };
  }
  return envelope;
}

function acceptSnapshot(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  const { continuation, remoteStreamOffsets, ...rest } = value as Record<string, unknown>;
  const checked = remoteStreamOffsets === true ? toSnapshotContinuation(continuation) : undefined;
  return checked ? { ...rest, continuation: checked } : rest;
}
