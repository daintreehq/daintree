import { z } from "zod";
import type { IpcEnvelope } from "../../../shared/types/ipc/errors.js";
import { MAX_TERMINAL_GRID_DIMENSION } from "../../../shared/types/terminal.js";
import { MAX_HOST_SUMMARY_DRIVERS } from "../../../shared/types/remoteHosts.js";
import { BULK_CHUNK_BYTES, Lane, type LinkFrame } from "./frames.js";
import {
  BulkKind,
  ControlKind,
  EventKind,
  InteractiveKind,
  RpcKind,
  TRANSFER_REASONS,
  frameToMessage,
  type LinkMessage,
} from "./messages.js";
import type { EncodingLimits } from "./encoding.js";

/**
 * Runtime validation for every message body that crosses the link. The frame
 * decoder and value decoder bound what a peer can make us allocate; these
 * schemas bound what it can make us act on. A body that fails its schema is a
 * protocol violation and ends the session.
 */

const u32 = z.number().int().min(0).max(0xffffffff);
const id = z.string().min(1).max(256);
const shortText = z.string().max(4096);
const channel = z.string().min(1).max(256);
const args = z.array(z.unknown()).max(64);
const epochMs = z.number().finite();
/** A project name a host sends: longer ones are cut there, since a body over its bounds ends the session. */
export const MAX_PROJECT_NAME_CHARS = 1024;

export const HandshakeSchema = z.object({
  version: z.string().min(1).max(64),
  commit: z.string().min(1).max(64),
  protocolVersion: z.number().int().min(0).max(0xffff),
  platform: z.enum(["darwin", "linux"]),
  arch: z.enum(["x64", "arm64"]),
});

const ClientInfoSchema = z.object({
  clientId: id,
  clientName: z.string().max(256),
  platform: z.enum(["darwin", "linux", "win32"]),
  deviceId: id.optional(),
});

export const HelloSchema = z.object({
  handshake: HandshakeSchema,
  token: z.string().min(1).max(256),
  client: ClientInfoSchema,
  resumeSessionId: id.nullable(),
  resumeSecret: z.string().max(256).nullable().optional(),
  messageFragments: z.boolean().optional(),
});

const WelcomeSchema = z.object({
  handshake: HandshakeSchema,
  hostName: z.string().max(256),
  sessionId: id,
  resumed: z.boolean(),
  resumeSecret: z.string().max(256).optional(),
  hostLaunchId: id.optional(),
  messageFragments: z.boolean().optional(),
  // One this side cannot read (a cause added after it) is dropped rather than
  // failing the WELCOME: the session matters more than saying why the last one ended.
  previousEnd: z
    .object({
      crashCause: z.enum([
        "uncaught-exception",
        "native-crash",
        "suspended-then-lost",
        "power-loss",
        "external-kill",
        "unknown",
      ]),
      cause: z.literal("watchdog-deadlock").optional(),
      watchdogKillReason: z
        .enum([
          "unresponsive",
          "unresponsive-under-pressure",
          "no-progress-under-external-pressure",
        ])
        .optional()
        .catch(undefined),
      missedBeats: z.number().int().min(1).max(1_000_000).optional().catch(undefined),
      pressureEvidence: z.string().max(256).optional().catch(undefined),
      at: epochMs,
    })
    .optional()
    .catch(undefined),
});

const RejectSchema = z.object({
  reason: z.enum(["unauthorized", "version-mismatch", "protocol", "busy", "shutting-down"]),
  handshake: HandshakeSchema.nullable(),
  detail: shortText.nullable(),
  observed: z
    .object({ workingAgents: z.number().int().min(0).max(1_000_000).nullable() })
    .optional(),
});

const PingSchema = z.object({ sentAt: epochMs, nonce: z.number().int().min(0).optional() });

const EndpointSchema = z.object({ endpointId: id, projectId: id.nullable() });
// An older host reads OPEN with `EndpointSchema`, which strips `openId`.
const EndpointOpenSchema = EndpointSchema.extend({ openId: id.optional() });
const EndpointCloseSchema = z.object({ endpointId: id });

export const DriveLeaseHolderSchema = z.object({
  leaseId: u32,
  tenureId: id.optional(),
  endpointId: id,
  clientId: id,
  clientName: z.string().max(256),
  isHostLocal: z.boolean(),
  acquiredAt: epochMs,
});

const DriveLeaseStateSchema = z.object({
  projectId: id,
  holder: DriveLeaseHolderSchema.nullable(),
});

/** One project's lease as its host sees it; summaries and the activity read both carry these. */
export const DriverObservationSchema = z.object({
  projectId: id,
  projectName: z.string().max(MAX_PROJECT_NAME_CHARS).nullable(),
  holder: DriveLeaseHolderSchema,
  state: z.enum(["live", "away"]),
  awayUntil: epochMs.nullable(),
});

const nullableCount = z.number().finite().min(0).nullable();
const count = z.number().int().min(0);
const coreCount = z.number().int().min(1);
const percent = z.number().finite().min(0).max(100);

const HostSummarySchema = z.object({
  hostId: id,
  sampledAt: epochMs,
  platform: z.enum(["darwin", "linux"]),
  cpuPercent: z.number().finite().nullable(),
  cpuLogicalCoreCount: coreCount.nullable().optional(),
  cpuLoadAverage1m: z.number().finite().min(0).nullable().optional(),
  cpuPerformanceCoreCount: coreCount.nullable().optional(),
  cpuEfficiencyCoreCount: coreCount.nullable().optional(),
  cpuPerformancePercent: percent.nullable().optional(),
  cpuEfficiencyPercent: percent.nullable().optional(),
  metricsScope: z.enum(["host", "cgroup"]).nullable().optional(),
  cpuCapacityCores: z.number().finite().positive().nullable().optional(),
  memoryPressureSomeAvg10: percent.nullable().optional(),
  temperatureCelsius: z.number().finite().min(-100).max(250).nullable().optional(),
  temperatureZone: z.string().max(256).nullable().optional(),
  memoryPressure: z.enum(["normal", "warn", "critical"]).nullable(),
  memoryUsedBytes: nullableCount,
  memoryTotalBytes: nullableCount,
  swapUsedBytes: nullableCount,
  swapTotalBytes: nullableCount,
  swapInBytesPerSec: nullableCount.optional(),
  swapOutBytesPerSec: nullableCount.optional(),
  thermal: z.enum(["nominal", "fair", "serious", "critical"]).nullable(),
  cpuPressure: z.number().finite().nullable(),
  agentsObserved: z.object({ working: count, waiting: count, idle: count }).nullable(),
  agentAttention: z.object({ waiting: count, blocked: count, idle: count }).optional(),
  projectCount: count.nullable(),
  worktreeCount: count.nullable(),
  driver: DriveLeaseHolderSchema.nullable(),
  drivers: z.array(DriverObservationSchema).max(MAX_HOST_SUMMARY_DRIVERS).nullable().optional(),
  agentClis: z.array(z.object({ agentId: id, version: z.string().max(256).nullable() })).max(256),
  timing: z
    .object({
      sampleAgeMs: z.number().finite().min(0).nullable(),
      afterPing: z.number().int().min(0).nullable(),
    })
    .optional(),
  forges: z
    .array(
      z.object({
        providerId: z.string().min(1).max(256),
        name: z.string().max(256),
        hasCredential: z.boolean(),
        account: z.string().max(256).nullable(),
      })
    )
    .max(64)
    .nullable()
    .optional(),
});

const GoodbyeSchema = z.object({ reason: shortText });

const SerializedErrorSchema = z.looseObject({
  name: z.string().max(256),
  message: z.string().max(64 * 1024),
  code: z.string().max(256).optional(),
});

export const EnvelopeSchema: z.ZodType<IpcEnvelope> = z.union([
  z.object({ __daintreeIpcEnvelope: z.literal(true), ok: z.literal(true), data: z.unknown() }),
  z.object({
    __daintreeIpcEnvelope: z.literal(true),
    ok: z.literal(false),
    error: SerializedErrorSchema,
  }),
]) as z.ZodType<IpcEnvelope>;

const ResultSchema = z.object({ requestId: u32, envelope: EnvelopeSchema });

const InvokeSchema = z.object({ requestId: u32, endpointId: id, channel, args });
const SendSchema = z.object({ endpointId: id, channel, args });
const ReverseRequestSchema = z.object({
  requestId: u32,
  endpointId: id,
  method: channel,
  payload: z.unknown(),
});
const CallSchema = z.object({ requestId: u32, method: channel, payload: z.unknown() });

const EventSchema = z.object({ endpointId: id.nullable(), channel, args });
const CanopyTerminalSchema = z.object({
  endpointId: id,
  channel: z.literal("canopy:terminal-data"),
  args: z.tuple([z.unknown()]),
});

const TerminalOutSchema = z.object({
  endpointId: id,
  terminalId: id,
  incarnation: u32,
  seq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  message: z.unknown(),
});
const PortMessageSchema = z.object({ endpointId: id, message: z.unknown() });
const TerminalResetSchema = z.object({
  endpointId: id,
  terminalId: id,
  incarnation: u32,
  snapshot: z
    .object({
      data: z.string(),
      cols: z.number().int().min(1).max(MAX_TERMINAL_GRID_DIMENSION),
      rows: z.number().int().min(1).max(MAX_TERMINAL_GRID_DIMENSION),
      // Absent from a host that does not forward stream offsets. One this side
      // cannot read is dropped rather than failing the frame, which would end
      // the session over metadata the repaint can do without.
      continuation: z
        .object({
          pendingEscapeTail: z.string().nullable(),
          streamOffset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
        })
        .optional()
        .catch(undefined),
    })
    .nullable(),
  seq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});

const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);

export const TransferBeginSchema = z.object({
  transferId: u32.min(1),
  name: z.string().min(1).max(1024),
  size: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  sha256: Sha256Hex,
  destination: z.union([
    z.object({ kind: z.literal("inbox"), bucket: z.enum(["clipboard", "files"]) }),
    z.object({ kind: z.literal("path"), path: z.string().min(1).max(4096) }),
  ]),
});
const TransferEndSchema = z.object({ transferId: u32.min(1) });
const TransferReasonSchema = z.enum(TRANSFER_REASONS);
const TransferAbortSchema = z.object({ transferId: u32.min(1), reason: TransferReasonSchema });
const TransferAckSchema = z.object({
  transferId: u32.min(1),
  receivedBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  path: z.string().max(4096).nullable(),
  error: TransferReasonSchema.nullable(),
});

const BODY_SCHEMAS: Record<number, Record<number, z.ZodType>> = {
  [Lane.CONTROL]: {
    [ControlKind.HELLO]: HelloSchema,
    [ControlKind.WELCOME]: WelcomeSchema,
    [ControlKind.REJECT]: RejectSchema,
    [ControlKind.PING]: PingSchema,
    [ControlKind.PONG]: PingSchema,
    [ControlKind.ENDPOINT_OPEN]: EndpointOpenSchema,
    [ControlKind.ENDPOINT_REBIND]: EndpointSchema,
    [ControlKind.ENDPOINT_CLOSE]: EndpointCloseSchema,
    [ControlKind.HOST_SUMMARY]: HostSummarySchema,
    [ControlKind.LEASE_CHANGED]: DriveLeaseStateSchema,
    [ControlKind.GOODBYE]: GoodbyeSchema,
  },
  [Lane.RPC]: {
    [RpcKind.INVOKE]: InvokeSchema,
    [RpcKind.INVOKE_RESULT]: ResultSchema,
    [RpcKind.SEND]: SendSchema,
    [RpcKind.REVERSE_REQUEST]: ReverseRequestSchema,
    [RpcKind.REVERSE_RESULT]: ResultSchema,
    [RpcKind.CALL]: CallSchema,
    [RpcKind.CALL_RESULT]: ResultSchema,
  },
  [Lane.EVENTS]: {
    [EventKind.EVENT]: EventSchema,
  },
  [Lane.INTERACTIVE]: {
    [InteractiveKind.TERMINAL_OUT]: TerminalOutSchema,
    [InteractiveKind.TERMINAL_IN]: PortMessageSchema,
    [InteractiveKind.TERMINAL_RESET]: TerminalResetSchema,
    [InteractiveKind.WORKTREE_PORT]: PortMessageSchema,
    [InteractiveKind.CANOPY_TERMINAL]: CanopyTerminalSchema,
  },
  [Lane.BULK]: {
    [BulkKind.TRANSFER_BEGIN]: TransferBeginSchema,
    [BulkKind.TRANSFER_END]: TransferEndSchema,
    [BulkKind.TRANSFER_ABORT]: TransferAbortSchema,
    [BulkKind.TRANSFER_ACK]: TransferAckSchema,
  },
};

/** Whether a lane carries a structured (encoded) message of this kind. */
export function isStructuredKind(lane: number, kind: number): boolean {
  return BODY_SCHEMAS[lane]?.[kind] !== undefined;
}

export class LinkValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LinkValidationError";
  }
}

/**
 * Decode and validate one inbound frame. Throws {@link LinkValidationError}
 * for an unknown kind, a malformed body, or an oversized bulk chunk, and lets
 * the value decoder's own errors through; either way the caller must end the
 * session.
 */
export function parseInboundFrame(frame: LinkFrame, limits?: EncodingLimits): LinkMessage {
  if (frame.lane === Lane.BULK && frame.kind === BulkKind.TRANSFER_CHUNK) {
    if (frame.streamId === 0) throw new LinkValidationError("transfer chunk without a stream id");
    if (frame.payload.byteLength === 0 || frame.payload.byteLength > BULK_CHUNK_BYTES) {
      throw new LinkValidationError(`transfer chunk of ${frame.payload.byteLength} bytes`);
    }
    return frameToMessage(frame, limits);
  }
  const schema = BODY_SCHEMAS[frame.lane]?.[frame.kind];
  if (!schema) throw new LinkValidationError(`unknown message ${frame.lane}/${frame.kind}`);
  if (frame.streamId !== 0) {
    throw new LinkValidationError(`unexpected stream id on ${frame.lane}/${frame.kind}`);
  }
  const message = frameToMessage(frame, limits);
  const parsed = schema.safeParse(message.body);
  if (!parsed.success) {
    throw new LinkValidationError(`invalid body for ${frame.lane}/${frame.kind}`);
  }
  return { lane: frame.lane, kind: frame.kind, body: parsed.data } as LinkMessage;
}

/** Check an outbound message against the same rules the peer will apply. */
export function assertOutboundMessage(message: LinkMessage): void {
  if (message.lane === Lane.BULK && message.kind === BulkKind.TRANSFER_CHUNK) {
    const size = message.body.byteLength;
    if (message.streamId === 0 || size === 0 || size > BULK_CHUNK_BYTES) {
      throw new LinkValidationError(`transfer chunk of ${size} bytes`);
    }
    return;
  }
  const schema = BODY_SCHEMAS[message.lane]?.[message.kind];
  if (!schema) throw new LinkValidationError(`unknown message ${message.lane}/${message.kind}`);
  if (!schema.safeParse(message.body).success) {
    throw new LinkValidationError(`invalid body for ${message.lane}/${message.kind}`);
  }
}
