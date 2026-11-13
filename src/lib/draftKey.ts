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

/** Whether any draft key for `terminalId` holds more than whitespace, whatever its scope. */
export function hasDraftText(drafts: ReadonlyMap<string, string>, terminalId: string): boolean {
  const suffix = `:${terminalId}`;
  for (const [key, value] of drafts) {
    if ((key === terminalId || key.endsWith(suffix)) && value.trim().length > 0) return true;
  }
  return false;
}

const ISOLATED_COMPOSER_SCOPE = "isolated-composer";

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
