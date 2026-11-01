import type { IpcEnvelope } from "../../../shared/types/ipc/errors.js";
import type { SerializedTerminalSnapshot } from "../../../shared/types/terminal.js";
import type {
  DriveLeaseState,
  HostHandshakeInfo,
  HostMetricsSummary,
  HostPlatform,
  HostPreviousEnd,
} from "../../../shared/types/remoteHosts.js";
import { decodeValue, encodeValue, type EncodingLimits } from "./encoding.js";
import { Lane, type LinkFrame } from "./frames.js";

/**
 * Typed messages carried by link frames. `kind` is unique per lane; the body
 * is the bounded structured encoding of the message object, except for bulk
 * chunks, whose frame payload is the raw bytes.
 */

export const ControlKind = {
  HELLO: 1,
  WELCOME: 2,
  REJECT: 3,
  PING: 4,
  PONG: 5,
  ENDPOINT_OPEN: 6,
  ENDPOINT_REBIND: 7,
  ENDPOINT_CLOSE: 8,
  HOST_SUMMARY: 9,
  LEASE_CHANGED: 10,
  GOODBYE: 11,
} as const;

export const RpcKind = {
  INVOKE: 1,
  INVOKE_RESULT: 2,
  SEND: 3,
  REVERSE_REQUEST: 4,
  REVERSE_RESULT: 5,
  CALL: 6,
  CALL_RESULT: 7,
} as const;

export const EventKind = {
  EVENT: 1,
} as const;

export const InteractiveKind = {
  /** Host → client: a message the pty-host posted on the endpoint's terminal port, stamped for replay. */
  TERMINAL_OUT: 1,
  /** Client → host: a message the renderer posted on its terminal port (write, resize, ack, …). */
  TERMINAL_IN: 2,
  /** Host → client: discard what the renderer has for a terminal and repaint from a snapshot. */
  TERMINAL_RESET: 3,
  /** Either direction: a worktree-port RPC message for an endpoint. */
  WORKTREE_PORT: 4,
  /**
   * Host → client: a Canopy viewer's live terminal stream, sent only to a
   * viewer that asked for it, so its echo takes turns with grid panes' output
   * rather than queueing behind every event.
   */
  CANOPY_TERMINAL: 5,
} as const;

export const BulkKind = {
  TRANSFER_BEGIN: 1,
  TRANSFER_CHUNK: 2,
  TRANSFER_END: 3,
  TRANSFER_ABORT: 4,
  TRANSFER_ACK: 5,
} as const;

export interface LinkClientInfo {
  clientId: string;
  clientName: string;
  platform: HostPlatform | "win32";
  /**
   * Stable for this Daintree install (its own user data), unlike `clientId`,
   * which is minted per launch, and unlike `clientName`, which two machines
   * (or two installs on one) can share. Absent from older Shells.
   */
  deviceId?: string;
}

export interface HelloMessage {
  handshake: HostHandshakeInfo;
  token: string;
  client: LinkClientInfo;
  /** Present when resuming: the session id from the previous WELCOME. */
  resumeSessionId: string | null;
  /**
   * With `resumeSessionId`: the secret that WELCOME carried. The session id
   * travels in lease and summary records other Shells see; this never does.
   */
  resumeSecret?: string | null;
  /**
   * This Shell reads message fragments (#15892), so the host may cut a large
   * message into them. Absent from older Shells, which get whole frames.
   */
  messageFragments?: boolean;
}

export interface WelcomeMessage {
  handshake: HostHandshakeInfo;
  hostName: string;
  sessionId: string;
  resumed: boolean;
  /** What a later HELLO must present to resume this session; new on every WELCOME. */
  resumeSecret?: string;
  /**
   * Names the host's process, the same on every session it serves: a Shell
   * that sees it change knows the host restarted and took its terminals with
   * it, which a session that merely expired never does. Absent from hosts
   * before it.
   */
  hostLaunchId?: string;
  /**
   * How the process before this one ended, when it ended uncleanly (#14368):
   * what lets a Shell tell a crash from a planned restart. Absent from hosts
   * before it.
   */
  previousEnd?: HostPreviousEnd;
  /**
   * This host reads message fragments (#15892), so the Shell may cut a large
   * message into them. Absent from older hosts, which get whole frames.
   */
  messageFragments?: boolean;
}

export type RejectReason =
  "unauthorized" | "version-mismatch" | "protocol" | "busy" | "shutting-down";

export interface RejectMessage {
  reason: RejectReason;
  handshake: HostHandshakeInfo | null;
  detail: string | null;
  /**
   * On a build refusal to a client that presented the right token: what the
   * host saw its agents doing, so a Shell on another build can still tell
   * whether updating would interrupt work. Absent from hosts before it.
   */
  observed?: RejectObservation;
}

export interface RejectObservation {
  /** Agents the host observed working; null when it couldn't see them all. */
  workingAgents: number | null;
}

export interface PingMessage {
  sentAt: number;
  /** Counts this session's pings, so a summary can name the last one it followed. Absent from older peers. */
  nonce?: number;
}

/**
 * What a host adds to a summary frame so a Shell can bound its age without
 * comparing clocks (#14462): how old the sample was by the host's own clocks
 * when it posted the frame, and the newest ping it had from that Shell then.
 */
export interface SummaryFrameTiming {
  sampleAgeMs: number | null;
  afterPing: number | null;
}

export type HostSummaryFrame = HostMetricsSummary & { timing?: SummaryFrameTiming };

export interface EndpointOpenMessage {
  endpointId: string;
  projectId: string | null;
  /**
   * Names this open of `endpointId`, so a view closed and opened again under
   * the same id can be told from one that never closed. A Shell from before
   * it sends none, and a host from before it drops it.
   */
  openId?: string;
}

export interface EndpointRebindMessage {
  endpointId: string;
  projectId: string | null;
}

export interface EndpointCloseMessage {
  endpointId: string;
}

export interface GoodbyeMessage {
  reason: string;
}

export interface InvokeMessage {
  requestId: number;
  endpointId: string;
  channel: string;
  args: unknown[];
}

export interface InvokeResultMessage {
  requestId: number;
  envelope: IpcEnvelope;
}

export interface SendMessage {
  endpointId: string;
  channel: string;
  args: unknown[];
}

/** Host → client request answered by the driving renderer (MCP dispatch, plugin prompts). */
export interface ReverseRequestMessage {
  requestId: number;
  endpointId: string;
  method: string;
  payload: unknown;
}

export interface ReverseResultMessage {
  requestId: number;
  envelope: IpcEnvelope;
}

/**
 * Session-level service call that is not an IPC channel: terminal resume,
 * operation status, transfer negotiation, lease takeover. `method` names a
 * handler registered on the receiving side.
 */
export interface CallMessage {
  requestId: number;
  method: string;
  payload: unknown;
}

export interface CallResultMessage {
  requestId: number;
  envelope: IpcEnvelope;
}

export interface EventMessage {
  /** Null addresses every endpoint of the session. */
  endpointId: string | null;
  channel: string;
  args: unknown[];
}

/** A viewer's `canopy:terminal-data` push, as an event addressed to it. */
export interface CanopyTerminalMessage {
  endpointId: string;
  channel: "canopy:terminal-data";
  args: [unknown];
}

export interface TerminalOutMessage {
  endpointId: string;
  terminalId: string;
  /** PTY incarnation (the launch generation); a change means the PTY restarted. */
  incarnation: number;
  /** Per-terminal output sequence number, monotonic within an incarnation. 0 for non-data messages. */
  seq: number;
  message: unknown;
}

export interface TerminalInMessage {
  endpointId: string;
  message: unknown;
}

export interface TerminalResetMessage {
  endpointId: string;
  terminalId: string;
  incarnation: number;
  /** Serialized terminal state and the grid it was captured at, or null to clear. */
  snapshot: SerializedTerminalSnapshot | null;
  /** Output with seq > this follows the snapshot. */
  seq: number;
}

export interface WorktreePortMessage {
  endpointId: string;
  message: unknown;
}

export interface TransferBeginMessage {
  transferId: number;
  name: string;
  size: number;
  /** Hex sha256 of the whole content, verified on the receiving side. */
  sha256: string;
  destination: { kind: "inbox"; bucket: "clipboard" | "files" } | { kind: "path"; path: string };
}

export interface TransferEndMessage {
  transferId: number;
}

/**
 * Why a transfer stopped, as it crosses the link. A fixed vocabulary rather
 * than exception text: messages from the far side's filesystem can name its
 * paths, and the diagnostic is logged where it happened instead.
 */
export const TRANSFER_REASONS = [
  "cancelled",
  "source-failed",
  "sink-failed",
  "checksum-mismatch",
  "invalid-data",
  "timeout",
  "too-large",
  "busy",
  "not-accepted",
] as const;
export type TransferReason = (typeof TRANSFER_REASONS)[number];

export interface TransferAbortMessage {
  transferId: number;
  reason: TransferReason;
}

export interface TransferAckMessage {
  transferId: number;
  receivedBytes: number;
  /** Set once the receiver has verified and placed the file. */
  path: string | null;
  error: TransferReason | null;
}

export type LinkMessage =
  | { lane: typeof Lane.CONTROL; kind: typeof ControlKind.HELLO; body: HelloMessage }
  | { lane: typeof Lane.CONTROL; kind: typeof ControlKind.WELCOME; body: WelcomeMessage }
  | { lane: typeof Lane.CONTROL; kind: typeof ControlKind.REJECT; body: RejectMessage }
  | { lane: typeof Lane.CONTROL; kind: typeof ControlKind.PING; body: PingMessage }
  | { lane: typeof Lane.CONTROL; kind: typeof ControlKind.PONG; body: PingMessage }
  | { lane: typeof Lane.CONTROL; kind: typeof ControlKind.ENDPOINT_OPEN; body: EndpointOpenMessage }
  | {
      lane: typeof Lane.CONTROL;
      kind: typeof ControlKind.ENDPOINT_REBIND;
      body: EndpointRebindMessage;
    }
  | {
      lane: typeof Lane.CONTROL;
      kind: typeof ControlKind.ENDPOINT_CLOSE;
      body: EndpointCloseMessage;
    }
  | { lane: typeof Lane.CONTROL; kind: typeof ControlKind.HOST_SUMMARY; body: HostSummaryFrame }
  | { lane: typeof Lane.CONTROL; kind: typeof ControlKind.LEASE_CHANGED; body: DriveLeaseState }
  | { lane: typeof Lane.CONTROL; kind: typeof ControlKind.GOODBYE; body: GoodbyeMessage }
  | { lane: typeof Lane.RPC; kind: typeof RpcKind.INVOKE; body: InvokeMessage }
  | { lane: typeof Lane.RPC; kind: typeof RpcKind.INVOKE_RESULT; body: InvokeResultMessage }
  | { lane: typeof Lane.RPC; kind: typeof RpcKind.SEND; body: SendMessage }
  | { lane: typeof Lane.RPC; kind: typeof RpcKind.REVERSE_REQUEST; body: ReverseRequestMessage }
  | { lane: typeof Lane.RPC; kind: typeof RpcKind.REVERSE_RESULT; body: ReverseResultMessage }
  | { lane: typeof Lane.RPC; kind: typeof RpcKind.CALL; body: CallMessage }
  | { lane: typeof Lane.RPC; kind: typeof RpcKind.CALL_RESULT; body: CallResultMessage }
  | { lane: typeof Lane.EVENTS; kind: typeof EventKind.EVENT; body: EventMessage }
  | {
      lane: typeof Lane.INTERACTIVE;
      kind: typeof InteractiveKind.TERMINAL_OUT;
      body: TerminalOutMessage;
    }
  | {
      lane: typeof Lane.INTERACTIVE;
      kind: typeof InteractiveKind.TERMINAL_IN;
      body: TerminalInMessage;
    }
  | {
      lane: typeof Lane.INTERACTIVE;
      kind: typeof InteractiveKind.TERMINAL_RESET;
      body: TerminalResetMessage;
    }
  | {
      lane: typeof Lane.INTERACTIVE;
      kind: typeof InteractiveKind.WORKTREE_PORT;
      body: WorktreePortMessage;
    }
  | {
      lane: typeof Lane.INTERACTIVE;
      kind: typeof InteractiveKind.CANOPY_TERMINAL;
      body: CanopyTerminalMessage;
    }
  | { lane: typeof Lane.BULK; kind: typeof BulkKind.TRANSFER_BEGIN; body: TransferBeginMessage }
  | {
      lane: typeof Lane.BULK;
      kind: typeof BulkKind.TRANSFER_CHUNK;
      body: Uint8Array;
      streamId: number;
    }
  | { lane: typeof Lane.BULK; kind: typeof BulkKind.TRANSFER_END; body: TransferEndMessage }
  | { lane: typeof Lane.BULK; kind: typeof BulkKind.TRANSFER_ABORT; body: TransferAbortMessage }
  | { lane: typeof Lane.BULK; kind: typeof BulkKind.TRANSFER_ACK; body: TransferAckMessage };

function isRawChunk(lane: number, kind: number): boolean {
  return lane === Lane.BULK && kind === BulkKind.TRANSFER_CHUNK;
}

export function messageToFrame(message: LinkMessage, limits?: EncodingLimits): LinkFrame {
  if (isRawChunk(message.lane, message.kind)) {
    const chunk = message as { lane: Lane; kind: number; body: Uint8Array; streamId: number };
    return { lane: chunk.lane, kind: chunk.kind, streamId: chunk.streamId, payload: chunk.body };
  }
  return {
    lane: message.lane,
    kind: message.kind,
    streamId: 0,
    payload: encodeValue(message.body, limits),
  };
}

/**
 * Decode a frame into a message. The body's shape is not validated here:
 * receivers must validate every inbound body as rigorously as today's IPC
 * boundary before acting on it.
 */
export function frameToMessage(frame: LinkFrame, limits?: EncodingLimits): LinkMessage {
  if (isRawChunk(frame.lane, frame.kind)) {
    return {
      lane: Lane.BULK,
      kind: BulkKind.TRANSFER_CHUNK,
      body: frame.payload,
      streamId: frame.streamId,
    };
  }
  return {
    lane: frame.lane,
    kind: frame.kind,
    body: decodeValue(frame.payload, limits),
  } as LinkMessage;
}
