import type { IpcEnvelope } from "../../../shared/types/ipc/errors.js";
import type {
  DriveLeaseState,
  HostHandshakeInfo,
  HostMetricsSummary,
  HostPlatform,
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
}

export interface HelloMessage {
  handshake: HostHandshakeInfo;
  token: string;
  client: LinkClientInfo;
  /** Present when resuming: the session id from the previous WELCOME. */
  resumeSessionId: string | null;
}

export interface WelcomeMessage {
  handshake: HostHandshakeInfo;
  hostName: string;
  sessionId: string;
  resumed: boolean;
}

export type RejectReason =
  "unauthorized" | "version-mismatch" | "protocol" | "busy" | "shutting-down";

export interface RejectMessage {
  reason: RejectReason;
  handshake: HostHandshakeInfo | null;
  detail: string | null;
}

export interface PingMessage {
  sentAt: number;
}

export interface EndpointOpenMessage {
  endpointId: string;
  projectId: string | null;
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
  /** Serialized terminal state to repaint from, or null to clear. */
  snapshot: string | null;
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

export interface TransferAbortMessage {
  transferId: number;
  reason: string;
}

export interface TransferAckMessage {
  transferId: number;
  receivedBytes: number;
  /** Set once the receiver has verified and placed the file. */
  path: string | null;
  error: string | null;
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
  | { lane: typeof Lane.CONTROL; kind: typeof ControlKind.HOST_SUMMARY; body: HostMetricsSummary }
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
