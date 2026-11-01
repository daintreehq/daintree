/**
 * The actions a host's MCP server may run in a view of this Shell: the
 * project-bound terminal, worktree, agent and recipe actions an agent drives
 * on the host it is working on, plus reads of the view's own context.
 *
 * Default deny. A host is another machine, and everything outside this list
 * reaches into this one — its clipboard (`terminal.paste`, the copy actions),
 * its filesystem and editors, its browser (`*.openPR`, external URLs), its
 * settings and plugins — or is simply not audited for a caller this Shell
 * does not control. An action a new release adds stays out until it is added
 * here.
 *
 * The forge reads (#15399) ask the host's own forge: their channels run where
 * the project lives, with the host's credentials, so nothing here is read.
 *
 * Four reach a little further, each on this Shell's terms:
 * - `browser.captureScreenshot` returns the pixels of a browser panel in the
 *   view the host already drives, as bytes; nothing lands on this clipboard.
 * - `file.view` shows a host file in the view's ephemeral read-only dialog,
 *   so an agent can show the person here a file without `open` firing on the
 *   host's own display. The view reads it from the host, whose file service
 *   serves only files inside the project and its worktrees, and draws an SVG
 *   as an isolated image so its markup cannot fetch from this machine. The
 *   dialog is never restored; only the person here can promote it to a
 *   lasting panel.
 * - `host.switch` is `danger: "confirm"`, so a host asking to move this window
 *   raises this Shell's own dialog naming that host, and does nothing unless
 *   the person here approves.
 * - `project.openOnHost` only opens the switch dialog here, marked as asked
 *   for by an agent so it never opens the project on its own; every push,
 *   clone and switch in it is the person's own click.
 *
 * Some ids here never run in this view at all. The host's MCP server answers
 * them in its own main process — the batches (`*Many`, expanded there into
 * single calls this list already carries) and `agent.launchInNewWorktree`
 * (run there as the same create, wait and launch), `terminal.notifyWhenIdle`,
 * `mcp.surface`, `help.displayImage`, `skills.*`, `project.runCommand`,
 * `terminal.waitForExit` (the exits and closes it reads are the host's),
 * `assistant.list`, `assistant.start` and `agent.readQuota` (a Shell's
 * assistant reaches the host's own assistants through them while it drives
 * the project), `host.list` (a host can be a Shell to hosts of its own), the
 * reads and owned twins that act after a host-side check — and their
 * definitions here only throw, apart from `terminal.placeOwned`'s, which the
 * host's gate dispatches to its own view once ownership is checked.
 * They are listed because this list is also the manifest a host is shown: an
 * id left off it is a tool the host's session loses whenever a Shell drives
 * the project, though the host could still answer it (#13350). Listing one
 * also lets an approval for it raise this Shell's dialog.
 *
 * `actions.search`, `actions.list` and `actions.getSchema` read this view's
 * whole registry, so `viewRequests.ts` narrows their answers to this list.
 *
 * Two tools every MCP tier carries stay out: `diagnostics.openReview` collects
 * this Shell's diagnostics, not the host's, and `copyTree.generateAndCopyFile`
 * writes this Shell's clipboard.
 */
export const HOST_DISPATCHABLE_ACTION_IDS: ReadonlySet<string> = new Set([
  "actions.getContext",
  "actions.getSchema",
  "actions.list",
  "actions.search",
  "agent.getState",
  "agent.launch",
  "agent.launchMany",
  "agent.launchInNewWorktree",
  "agent.listAvailable",
  "agent.listModels",
  "agent.listPresets",
  // The host's own user presets: agent settings are host channels, so the write
  // lands where the agent runs, and each one raises this Shell's dialog (#16047).
  "agent.createPreset",
  "agent.updatePreset",
  "agent.deletePreset",
  "agent.readQuota",
  "assistant.list",
  "assistant.start",
  "browser.captureScreenshot",
  "file.view",
  "fleet.getRunStatus",
  "forge.getCIStatus",
  "forge.getChecks",
  "forge.getIssue",
  "forge.getPR",
  "forge.getPRs",
  "forge.listIssueComments",
  "forge.listIssues",
  "forge.listPRs",
  "help.displayImage",
  "host.list",
  "host.switch",
  "mcp.surface",
  "project.openOnHost",
  "project.runCommand",
  "recipe.list",
  "recipe.run",
  "skills.load",
  "skills.search",
  "slashCommands.list",
  "terminal.cancelWatch",
  "terminal.close",
  "terminal.closeMany",
  "terminal.closeOwned",
  "terminal.getOutput",
  "terminal.getStatus",
  "terminal.getWatchEvents",
  "terminal.info.get",
  "terminal.inject",
  "terminal.injectOwned",
  "terminal.interrupt",
  "terminal.interruptOwned",
  "terminal.kill",
  "terminal.killBatch",
  "terminal.list",
  "terminal.listWatches",
  "terminal.moveToWorktree",
  "terminal.new",
  "terminal.notifyWhenIdle",
  "terminal.placeOwned",
  "terminal.readLastMessageOwned",
  "terminal.registerWatch",
  "terminal.rename",
  "terminal.restart",
  "terminal.restartOnPreset",
  "terminal.restartOnPresetOwned",
  "terminal.revealOwned",
  "terminal.sendCommand",
  "terminal.sendCommandMany",
  "terminal.sendCommandOwned",
  "terminal.sendKeys",
  "terminal.sendKeysOwned",
  "terminal.setClientMetadata",
  "terminal.startHeld",
  "terminal.waitForExit",
  "terminal.waitUntilIdle",
  "terminal.waitUntilIdleBatch",
  "terminal.watch",
  "workspace.list",
  "worktree.create",
  "worktree.createWithRecipe",
  "worktree.delete",
  "worktree.deleteOwned",
  "worktree.retireOwned",
  "worktree.getAvailableBranch",
  "worktree.getCurrent",
  "worktree.getDefaultPath",
  "worktree.list",
  "worktree.listBranches",
  "worktree.refresh",
  "worktree.setActive",
  "worktree.waitForPullRequest",
  "worktree.waitUntilReady",
]);

/**
 * Host-dispatchable actions that always ask the person at this Shell, even
 * when the host says its assistant runs under "Never ask" (#13368). Both move
 * or reopen this window, which the list above admits only because the person
 * here approves every move.
 */
export const HOST_ALWAYS_ASKS_ACTION_IDS: ReadonlySet<string> = new Set([
  "host.switch",
  "project.openOnHost",
]);
