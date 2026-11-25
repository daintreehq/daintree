/**
 * Whether a Claude launch forks the conversation it reopens into a new one
 * (`--fork-session`), as a user's own launch flags may ask: the run is then
 * another conversation, whatever id it was resumed by (#17919). Read from the
 * flags themselves, so a prompt that only mentions the flag is no fork.
 */
export function isClaudeForkFlag(flag: string): boolean {
  return flag === "--fork-session" || flag.startsWith("--fork-session=");
}

export function forksClaudeConversation(
  flags: readonly string[] | undefined,
  agentId: string | undefined
): boolean {
  return agentId === "claude" && (flags ?? []).some(isClaudeForkFlag);
}
