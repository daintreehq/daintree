import { commandService } from "../CommandService.js";

/**
 * Register built-in Daintree commands.
 *
 * Both command modules are loaded via dynamic `import()` so they stay out of
 * the eager-import graph at app startup. Registration is fire-and-forget —
 * the command-service consumers (IPC handlers in `electron/ipc/handlers/commands.ts`)
 * only run after the renderer is interactive, by which time the registrations
 * have completed.
 */
export function registerCommands(): void {
  void (async () => {
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
