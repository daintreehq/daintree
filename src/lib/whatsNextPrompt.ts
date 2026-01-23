/**
 * Build a simple "What's Next?" prompt for the agent.
 *
 * The prompt is intentionally concise to avoid command-line escaping issues.
 * The agent has full access to tools (GitHub CLI, file system) and can gather
 * its own context dynamically rather than having it pre-injected.
 */
export function buildWhatsNextPrompt(): string {
  return "I am returning after a break. Please explore the open GitHub issues and codebase; if GitHub issues are unavailable, use README, TODOs, and recent commits. Then suggest 1-6 high-impact parallel tasks I should work on next that do not overlap.";
}
