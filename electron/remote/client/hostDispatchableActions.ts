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
 * Three reach a little further, each on this Shell's terms:
 * - `browser.captureScreenshot` returns the pixels of a browser panel in the
 *   view the host already drives, as bytes; nothing lands on this clipboard.
 * - `host.switch` is `danger: "confirm"`, so a host asking to move this window
 *   raises this Shell's own dialog naming that host, and does nothing unless
 *   the person here approves.
 * - `project.openOnHost` only opens the switch dialog here; every push, clone
 *   and switch in it is the person's own click.
 */
export const HOST_DISPATCHABLE_ACTION_IDS: ReadonlySet<string> = new Set([
  "actions.getContext",
  "actions.getSchema",
  "agent.getState",
  "agent.launch",
  "agent.listAvailable",
  "agent.listPresets",
  "browser.captureScreenshot",
  "fleet.getRunStatus",
  "host.switch",
  "project.openOnHost",
  "recipe.list",
  "recipe.run",
  "terminal.cancelWatch",
  "terminal.close",
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
  "terminal.new",
  "terminal.readLastMessageOwned",
  "terminal.registerWatch",
  "terminal.rename",
  "terminal.restart",
  "terminal.revealOwned",
  "terminal.sendCommand",
  "terminal.sendCommandOwned",
  "terminal.setClientMetadata",
  "terminal.waitUntilIdle",
  "terminal.waitUntilIdleBatch",
  "terminal.watch",
  "worktree.create",
  "worktree.createWithRecipe",
  "worktree.delete",
  "worktree.deleteOwned",
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
