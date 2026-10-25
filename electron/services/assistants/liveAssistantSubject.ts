import { AppError } from "../../utils/errorTypes.js";
import {
  AgentDirectorySubjectSchema,
  type AgentDirectorySubject,
} from "../../../shared/types/agentDirectory.js";
import type { GlobalAssistantState } from "../../../shared/types/ipc/help.js";
import type { PtyClient } from "../PtyClient.js";
import { GLOBAL_ASSISTANT_ID } from "../../../shared/config/globalAssistant.js";

/**
 * Where main looks to say which terminal an assistant subject names right now.
 * Assistants are held by their own services, never by the fleet, so this is the
 * only authority a person's viewer asks; the directory's retained snapshot is
 * never one.
 */
export interface LiveAssistantSources {
  hostId: string;
  ptyClient: Pick<PtyClient, "getLiveGeneration" | "getTerminalAsync">;
  getRunningLaneSession(
    projectId: string,
    slot: number
  ): { sessionId: string; terminalId: string } | null;
  onSessionEnded(
    listener: (event: { projectId: string; slot: number; sessionId: string }) => void
  ): () => void;
  /** The global assistant, when its service exists; null on an install that never made it. */
  global: {
    getState(): Pick<GlobalAssistantState, "phase" | "generation" | "terminalId">;
    onChange(listener: () => void): () => void;
    /** The window view whose attachment holds input now; null when none does. */
    inputOwnerWebContentsId(): number | null;
    /** Whether this attachment still holds input at the epoch it was given. */
    canWrite(attachmentId: string, epoch: number): boolean;
  } | null;
}

/**
 * The input ownership a window held when it opened its view of the global
 * session. Input through that view is accepted only while the very same
 * ownership stands: once input moves, even back to this window, the view is
 * read-only and anything still queued through it is refused.
 */
export interface GlobalAssistantInputStamp {
  attachmentId: string;
  inputEpoch: number;
}

export function parseGlobalAssistantInputStamp(value: unknown): GlobalAssistantInputStamp | null {
  if (value === undefined || value === null) return null;
  const stamp = value as Partial<GlobalAssistantInputStamp>;
  if (
    typeof value !== "object" ||
    typeof stamp.attachmentId !== "string" ||
    stamp.attachmentId.length === 0 ||
    stamp.attachmentId.length > 128 ||
    !Number.isSafeInteger(stamp.inputEpoch)
  ) {
    throw refuse("VALIDATION", "Invalid input stamp");
  }
  return { attachmentId: stamp.attachmentId, inputEpoch: stamp.inputEpoch as number };
}

/** One live assistant run, as main bound it when the person's viewer opened. */
export interface LiveAssistantBinding {
  subject: AgentDirectorySubject;
  /** The host record's incarnation stamp, for the terminal watch's own checks. */
  spawnedAt: number;
  /** The PTY launch generation the subject named and main confirmed. */
  launchGeneration: number;
  /** Whether main still holds this very session on this terminal. Synchronous. */
  isBound(): boolean;
  /** Call `end` when this session stops being the lane's (or the global one's) run. */
  onEnded(end: () => void): () => void;
  /** Whether this window view may type: a global session has one input owner at a time. */
  mayType(webContentsId: number): boolean;
}

function refuse(
  code: "VALIDATION" | "UNSUPPORTED" | "NOT_FOUND" | "STALE_GENERATION",
  message: string,
  userMessage?: string
): AppError {
  return new AppError({ code, message, ...(userMessage ? { userMessage } : {}) });
}

const GONE = "That assistant isn't running any more.";

/**
 * Resolve a person's chosen assistant to the exact run main holds for it. The
 * subject must name the lane (or the global session), the terminal under it
 * and its launch generation; a terminal id reused after a restart carries a
 * new generation and is refused, never followed. Reports only: nothing is
 * attached, claimed, started or resumed to answer.
 */
export async function resolveLiveAssistant(
  rawSubject: unknown,
  sources: LiveAssistantSources,
  inputStamp: GlobalAssistantInputStamp | null = null
): Promise<LiveAssistantBinding> {
  const parsed = AgentDirectorySubjectSchema.safeParse(rawSubject);
  if (!parsed.success) throw refuse("VALIDATION", "Invalid assistant subject");
  const subject = parsed.data;
  if (subject.hostId !== sources.hostId) {
    throw refuse(
      "UNSUPPORTED",
      "Assistants on another host aren't viewable from here yet.",
      "That assistant is on another host."
    );
  }

  let isBound: () => boolean;
  let onEnded: (end: () => void) => () => void;
  let mayType: (webContentsId: number) => boolean;

  if (subject.scope.kind === "project") {
    const { projectId } = subject.scope;
    const lane = subject.lane;
    if (lane === undefined) throw refuse("VALIDATION", "A project assistant names its lane");
    // The global session is held as a lane of its reserved id; named that way it
    // would skip the global session's one input owner.
    if (projectId === GLOBAL_ASSISTANT_ID) {
      throw refuse("VALIDATION", "The global assistant is named by its own scope");
    }
    const session = sources.getRunningLaneSession(projectId, lane);
    if (!session || session.terminalId !== subject.terminalId) {
      throw refuse("NOT_FOUND", GONE, GONE);
    }
    const { sessionId } = session;
    isBound = () => {
      const now = sources.getRunningLaneSession(projectId, lane);
      return now?.sessionId === sessionId && now.terminalId === subject.terminalId;
    };
    onEnded = (end) =>
      sources.onSessionEnded((event) => {
        if (event.projectId === projectId && event.slot === lane && event.sessionId === sessionId) {
          end();
        }
      });
    mayType = () => true;
  } else {
    if (subject.lane !== undefined) {
      throw refuse("VALIDATION", "The global assistant has no lane");
    }
    const global = sources.global;
    const state = global?.getState();
    if (!global || !state || state.phase !== "running" || state.terminalId !== subject.terminalId) {
      throw refuse("NOT_FOUND", GONE, GONE);
    }
    const { generation } = state;
    isBound = () => {
      const now = global.getState();
      return (
        now.phase === "running" &&
        now.terminalId === subject.terminalId &&
        now.generation === generation
      );
    };
    onEnded = (end) =>
      global.onChange(() => {
        if (!isBound()) end();
      });
    // Typing needs the ownership the view was opened under, still unmoved;
    // a view opened without one only reads.
    mayType = (webContentsId) =>
      inputStamp !== null &&
      global.canWrite(inputStamp.attachmentId, inputStamp.inputEpoch) &&
      global.inputOwnerWebContentsId() === webContentsId;
  }

  const launchGeneration = sources.ptyClient.getLiveGeneration(subject.terminalId);
  if (launchGeneration === null || launchGeneration !== subject.incarnation) {
    throw refuse("STALE_GENERATION", GONE, GONE);
  }
  // Strict: a live host slow to answer is not an assistant that has ended.
  let record: Awaited<ReturnType<LiveAssistantSources["ptyClient"]["getTerminalAsync"]>>;
  try {
    record = await sources.ptyClient.getTerminalAsync(subject.terminalId, undefined, {
      strict: true,
    });
  } catch (error) {
    throw new AppError({
      code: "INTERNAL",
      message: "The terminal host didn't answer about the assistant.",
      userMessage: "Couldn't reach that assistant's terminal. Try again in a moment.",
      cause: error instanceof Error ? error : undefined,
    });
  }
  // The host was asked, so main may have moved on while it answered.
  if (
    !record ||
    record.isExited === true ||
    typeof record.spawnedAt !== "number" ||
    !isBound() ||
    sources.ptyClient.getLiveGeneration(subject.terminalId) !== launchGeneration
  ) {
    throw refuse("NOT_FOUND", GONE, GONE);
  }

  return { subject, spawnedAt: record.spawnedAt, launchGeneration, isBound, onEnded, mayType };
}
