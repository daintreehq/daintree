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
 * The draft and history scope of an isolated composer, apart from every
 * project's; a terminal on another host keeps that host's apart from this one's.
 */
export function isolatedComposerScope(otherHostId?: string): string {
  return otherHostId !== undefined
    ? `${ISOLATED_COMPOSER_SCOPE}:${otherHostId}`
    : ISOLATED_COMPOSER_SCOPE;
}
