import type { ConversationStore } from "../types/panel.js";

const MAX_SESSION_ID_LENGTH = 128;
const MAX_CONFIG_DIR_LENGTH = 4096;
/** A POSIX root, a drive-qualified Windows path, or a UNC share. */
const ABSOLUTE_PATH = /^(?:\/|[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1F\x7F]/;

function isStoreText(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.trim() === value &&
    value.length > 0 &&
    value.length <= maxLength &&
    !CONTROL_CHARS.test(value)
  );
}

/**
 * A {@link ConversationStore} read from anything persisted or sent across a
 * process boundary, or undefined when it isn't one. The folder must be
 * absolute: the CLI resolves a relative one against its own cwd, which is not
 * a folder to guess at.
 */
export function readConversationStore(value: unknown): ConversationStore | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const { sessionId, configDir } = value as Record<string, unknown>;
  if (!isStoreText(sessionId, MAX_SESSION_ID_LENGTH)) return undefined;
  if (!isStoreText(configDir, MAX_CONFIG_DIR_LENGTH) || !ABSOLUTE_PATH.test(configDir)) {
    return undefined;
  }
  return { sessionId, configDir };
}

/**
 * The store when it belongs to `sessionId`, the conversation about to be
 * resumed or recorded, and undefined for any other: a store is never carried
 * onto a conversation it didn't hold (#17087).
 */
export function conversationStoreFor(
  store: unknown,
  sessionId: string | null | undefined
): ConversationStore | undefined {
  if (!sessionId) return undefined;
  const read = readConversationStore(store);
  return read?.sessionId === sessionId ? read : undefined;
}

/**
 * Whether a conversation this agent keeps across a switch reopens from the
 * folder it was written under, whichever account's folder the pane moves to
 * (#17087). Claude Code takes the transcript's path; the others are looked up
 * by id in the folder they run on.
 */
export function reopensFromConversationStore(agentId: string | undefined): boolean {
  return agentId === "claude";
}
