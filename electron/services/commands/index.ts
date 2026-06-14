import { commandService } from "../CommandService.js";

let registration: Promise<void> | null = null;

/**
 * Register built-in Daintree commands.
 *
 * Both command modules are loaded via dynamic `import()` so they stay out of
 * the eager-import graph at app startup. Registration runs from the deferred
 * queue's heavy group (post-first-interactive), so it is no longer guaranteed
 * to finish before the renderer's first commands IPC — consumers await
 * `builtinCommandsReady()` instead of relying on boot ordering. Failures are
 * swallowed after logging so a broken registration can't wedge every commands
 * IPC; the registry just stays empty.
 */
export function registerCommands(): void {
  if (registration) return;
  registration = (async () => {
    try {
      const [{ githubCreateIssueCommand }, { githubWorkIssueCommand }] = await Promise.all([
        import("./githubCreateIssue.js"),
        import("./githubWorkIssue.js"),
      ]);
      commandService.register(githubCreateIssueCommand);
      commandService.register(githubWorkIssueCommand);
    } catch (err) {
      console.error("[CommandService] Failed to register built-in commands:", err);
    }
  })();
}

export function builtinCommandsReady(): Promise<void> {
  registerCommands();
  return registration ?? Promise.resolve();
}
