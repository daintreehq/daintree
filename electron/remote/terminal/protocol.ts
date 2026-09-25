import { z } from "zod";
import { MAX_TERMINAL_GRID_DIMENSION } from "../../../shared/types/terminal.js";

/**
 * What the terminal stream carries inside the link's TERMINAL_IN/TERMINAL_OUT
 * envelopes, and the resume call. The link validates the envelope; these
 * validate the port message inside it before either side acts on it.
 */

export const TERMINAL_RESUME_METHOD = "terminal.resume";

const terminalId = z.string().min(1).max(256);
const byteCount = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const seq = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const incarnation = z.number().int().min(0).max(0xffffffff);

/**
 * Renderer → host messages a remote view may send. Worker-ingest routing is
 * deliberately absent: its dedicated ports cannot cross the link, so a remote
 * view always ingests on its window port.
 */
export const TerminalInPortMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("write"),
    id: terminalId,
    data: z.string().max(4 * 1024 * 1024),
    traceId: z.string().max(256).optional(),
  }),
  z.object({
    type: z.literal("resize"),
    id: terminalId,
    cols: z.number().int().min(1).max(MAX_TERMINAL_GRID_DIMENSION),
    rows: z.number().int().min(1).max(MAX_TERMINAL_GRID_DIMENSION),
  }),
  z.object({ type: z.literal("ack"), id: terminalId, bytes: byteCount }),
]);
export type TerminalInPortMessage = z.infer<typeof TerminalInPortMessageSchema>;

/** Host → renderer messages relayed from the pty-host port. */
export const TerminalOutPortMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("data"),
    id: terminalId,
    data: z.instanceof(Uint8Array),
    bytes: byteCount,
  }),
  z.object({
    type: z.literal("tier-changed"),
    id: terminalId,
    tier: z.enum(["active", "background"]),
  }),
  z.looseObject({
    type: z.literal("terminal-status"),
    id: terminalId,
    status: z.string().max(64),
    timestamp: z.number().finite(),
  }),
]);
export type TerminalOutPortMessage = z.infer<typeof TerminalOutPortMessageSchema>;

export const TerminalResumeRequestSchema = z.object({
  endpointId: z.string().min(1).max(256),
  terminals: z.array(z.object({ id: terminalId, incarnation, lastSeq: seq })).max(4096),
});
export type TerminalResumeRequest = z.infer<typeof TerminalResumeRequestSchema>;

/**
 * - `replayed`: the frames after `lastSeq` follow on the interactive lane.
 * - `reset`: a TERMINAL_RESET follows, then the frames after its boundary.
 * - `unknown`: the host holds no stream state for it; the client should adopt
 *   whatever arrives next rather than wait for a sequence it will never see.
 */
export type TerminalResumeOutcome = "replayed" | "reset" | "unknown";

export const TerminalResumeResultSchema = z.object({
  terminals: z
    .array(z.object({ id: terminalId, outcome: z.enum(["replayed", "reset", "unknown"]) }))
    .max(4096),
});
export type TerminalResumeResult = z.infer<typeof TerminalResumeResultSchema>;
