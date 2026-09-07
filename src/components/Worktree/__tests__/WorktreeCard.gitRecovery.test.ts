import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getGitRecoveryAction } from "@shared/utils/gitOperationErrors";
import type { GitOperationReason } from "@shared/types/ipc/errors";

/**
 * Source contract rather than a render, following the `file.view` sibling: what
 * needs pinning is which ARGUMENTS the card hands a dispatch, and reaching that
 * through a render would need a fixture larger than the rule.
 *
 * The rule: when a git action dispatched from the card menu fails, the toast
 * offers the one recovery `gitOperationErrors` maps for that reason — and hands
 * it the location spelling that action actually declares. This fails silently
 * rather than loudly, which is why it is pinned: `worktree.openReviewHub`
 * declares `z.object({ worktreeId })`, and Zod STRIPS unknown keys, so a stray
 * `cwd` parses to `{}` and `run()` falls back to the focused/active worktree —
 * opening a different card's Review Hub with no error anywhere.
 */
const source = readFileSync(fileURLToPath(new URL("../WorktreeCard.tsx", import.meta.url)), "utf8");

/** The git dispatch helper's body, comments stripped. */
function dispatchBody(): string {
  const start = source.indexOf("const dispatchGitAction =");
  expect(start, "the card no longer routes its git rows through a named helper").toBeGreaterThan(
    -1
  );
  const rest = source.slice(start);
  const next = rest.indexOf("\n  const ", 1);
  const body = (next === -1 ? rest : rest.slice(0, next))
    // Both comment forms: a `//` strip alone would let a block-commented call
    // satisfy the assertions below.
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  expect(body).toContain("actionService.dispatch");
  return body;
}

describe("WorktreeCard — git failure recovery (#12090)", () => {
  it("routes the failure by its decoded git reason, not by the raw message", () => {
    const body = dispatchBody();
    // `result.error.details` is the original throw; without decoding it every
    // reason collapses to one generic "Git operation failed" toast.
    expect(body).toContain("result.error.details");
    expect(body).toContain("isClientGitError");
    expect(body).toContain("getGitRecoveryAction");
  });

  it("hands worktree.openReviewHub an id, and the git actions a path", () => {
    const body = dispatchBody();
    expect(body).toMatch(/"worktree\.openReviewHub"[\s\S]*?worktreeId:\s*worktree\.id/);
    expect(body).toMatch(/cwd:\s*worktree\.path/);
  });

  it("prefers the table's own args wherever it supplies them", () => {
    // `auth-failed` routes into a specific settings tab; substituting a
    // location would open the settings pane on whatever tab was last used.
    expect(dispatchBody()).toMatch(/recovery\.args\s*\?\?/);
  });

  it("covers every action the recovery table can name", () => {
    // The card special-cases exactly one action id. A new table entry wanting a
    // third spelling has to be handled here too, so enumerate the live table
    // rather than restating it.
    const reasons: GitOperationReason[] = [
      "auth-failed",
      "push-rejected-outdated",
      "conflict-unresolved",
      "dubious-ownership",
    ];
    const argless = reasons
      .map((reason) => getGitRecoveryAction(reason))
      .filter((action) => action !== undefined)
      .filter((action) => action.args === undefined)
      .map((action) => action.actionId);

    expect(argless.length, "the recovery table stopped naming argless actions").toBeGreaterThan(0);

    const body = dispatchBody();
    // Every argless entry gets a location from the card, so every one of them
    // must be a shape the card actually produces.
    const producesWorktreeId = /worktreeId:\s*worktree\.id/.test(body);
    const producesCwd = /cwd:\s*worktree\.path/.test(body);
    for (const actionId of argless) {
      const wantsId = actionId.startsWith("worktree.");
      expect(
        wantsId ? producesWorktreeId : producesCwd,
        `${actionId} has no location spelling the card produces`
      ).toBe(true);
      if (wantsId) {
        expect(body, `${actionId} is not routed to the worktreeId branch`).toContain(actionId);
      }
    }
  });
});
