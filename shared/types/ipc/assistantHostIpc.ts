import type { AssistantHostEvent, AssistantHostReadyEvent } from "./assistantHost.js";

/**
 * IPC payloads for the native assistant engine.
 *
 * Separate from `assistantHost.ts` on purpose: that file is the WIRE contract with the
 * engine and must stay byte-identical to the Go side. These are Daintree's own
 * renderer↔main shapes and are free to change without touching the engine.
 */

/**
 * Environment the engine is started with. Secrets travel here, never in a message.
 *
 * Documentation of the shape, not the enforced one: the spawn takes a plain
 * `Record<string, string>` (`AssistantHostProcess`), and the real bag also carries the
 * tier and log-directory variables. What is load-bearing is the rule below, not this
 * list.
 *
 * Assembled in the MAIN process and deliberately absent from the start payload below:
 * this bag carries the MCP URL, the MCP token and the auto-approve switch, so a
 * renderer-supplied copy would let a compromised view point the engine at an MCP control
 * plane main never provisioned, or grant itself standing approval. Main owns it because
 * main is where the MCP session that the token belongs to is issued.
 *
 * No backend URL travels here, on purpose: the engine resolves and remembers its own
 * endpoint, and Daintree setting the variable would pin it — see the
 * `DAINTREE_BACKEND_URL` note in `AssistantHostService.startLocked`.
 */
export interface AssistantHostSessionEnv {
  DAINTREE_MCP_URL?: string;
  DAINTREE_MCP_TOKEN?: string;
  DAINTREE_WINDOW_ID?: string;
  DAINTREE_PROJECT_ID?: string;
  DAINTREE_ASSISTANT_AUTO_APPROVE?: string;
  DAINTREE_ASSISTANT_DEBUG_LOG?: string;
}

/**
 * NOTE: there is deliberately no `tier` here either, for the same reason there is no
 * `windowId`. The session's permission tier is decided in main — from the MCP bearer it
 * was provisioned with, or from the stored setting when provisioning failed and there is
 * no bearer to read — and the same value has to reach both the session descriptor and
 * the engine's own environment, which the engine cross-checks and refuses to boot on a
 * disagreement. A renderer-supplied tier could only ever be a second answer to a
 * question that must have exactly one.
 */
export interface AssistantHostStartPayload {
  projectId: string;
  /** Project root; the engine's working directory. */
  cwd: string;
}

/**
 * NOTE: there is deliberately no `windowId` here. The owning window and WebContents
 * are both derived in the main process from the IPC context — a renderer must not be
 * able to declare which window a session, and therefore its approval prompts, belongs
 * to. The engine treats the window id as informational anyway; the enforceable binding
 * is the pinned WebContents.
 */

export interface AssistantHostStartResult {
  sessionId: string;
  /**
   * The engine's own `host:ready` frame.
   *
   * Returned rather than left to the event stream because it is emitted before this
   * call resolves, and the renderer cannot match events to a session it has not been
   * told the id of yet — so the frame announcing the engine version and whether
   * approvals are switched off is precisely the one that races. Applying this makes
   * readiness a fact the engine stated, not one the renderer assumed.
   */
  ready: AssistantHostReadyEvent | null;
  /**
   * Events the engine emitted before the renderer could match them to a session.
   *
   * The subscriber discards every frame until it knows its own session id, so a boot
   * event — the control-plane status especially — would otherwise be spoken into an
   * empty room. Applied in order, after `ready`.
   */
  replay: AssistantHostEvent[];
  /**
   * Why this session has no Daintree control plane, or null when it has one.
   *
   * The engine runs perfectly well without MCP — it just cannot DO anything: spawning
   * an agent, the assistant's whole purpose, fails at the point of use with a message
   * about a variable the user has never heard of. Carrying the reason out of main lets
   * the panel say so up front instead.
   */
  mcpUnavailableReason: string | null;
}

/**
 * A gap in the engine's monotonic sequence. `missing` frames were lost between `after`
 * and `received`, so the transcript is incomplete from that point.
 */
export interface AssistantHostGapPayload {
  sessionId: string;
  after: number;
  received: number;
  missing: number;
}

/** The engine process exited. */
export interface AssistantHostExitPayload {
  sessionId: string;
  code: number | null;
  signal: NodeJS.Signals | null;
}
