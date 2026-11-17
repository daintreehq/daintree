/**
 * Creates a composite key for draft inputs that includes the project context.
 * This allows draft inputs to persist across project switches by associating
 * them with both the project and terminal ID.
 *
 * Key format: `{projectId}:{terminalId}` when projectId is provided,
 * otherwise just `{terminalId}` for backward compatibility.
 */
export function makeDraftKey(terminalId: string, projectId?: string): string {
  return projectId ? `${projectId}:${terminalId}` : terminalId;
}

const ISOLATED_COMPOSER_SCOPE = "isolated-composer";

/**
 * Whether `key` is a draft key for this host's `terminalId`, whatever its
 * scope. A draft for another host's terminal of the same id is that host's.
 * The isolated key is matched whole first, since an id may itself hold a colon.
 */
export function isTerminalDraftKey(key: string, terminalId: string): boolean {
  if (key === terminalId || key === `${ISOLATED_COMPOSER_SCOPE}:${terminalId}`) return true;
  return key.endsWith(`:${terminalId}`) && !isOtherHostDraftKey(key);
}

/** Whether any of this host's draft keys for `terminalId` holds more than whitespace. */
export function hasDraftText(drafts: ReadonlyMap<string, string>, terminalId: string): boolean {
  for (const [key, value] of drafts) {
    if (isTerminalDraftKey(key, terminalId) && value.trim().length > 0) return true;
  }
  return false;
}

/** A draft kept for a terminal on another host (`isolated-composer:{hostId}:{terminalId}`). */
export function isOtherHostDraftKey(key: string): boolean {
  const prefix = `${ISOLATED_COMPOSER_SCOPE}:`;
  return key.startsWith(prefix) && key.slice(prefix.length).includes(":");
}

/**
 * The draft scope of an isolated composer, apart from every project's; a
 * terminal on another host keeps that host's apart from this one's. Prompt
 * history is kept by project, never under this scope.
 */
export function isolatedComposerScope(otherHostId?: string): string {
  return otherHostId !== undefined
    ? `${ISOLATED_COMPOSER_SCOPE}:${otherHostId}`
    : ISOLATED_COMPOSER_SCOPE;
}
