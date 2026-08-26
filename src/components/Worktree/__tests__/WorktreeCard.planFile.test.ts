import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Source contract rather than a render, for the same reason as the Browse Files
 * sibling: WorktreeCard pulls in the whole worktree/panel/agent store graph, and
 * what needs pinning is which arguments the card hands the dispatch — a fact a
 * render assertion would only reach through a fixture larger than the rule.
 *
 * The rule: the plan file opens through the generic `file.view` dialog, bound to
 * the card's OWN worktree (#11942). Left unnamed, `file.view` resolves the
 * binding from the path, and that answer decides the pane's read root and which
 * grid bucket a promotion lands in.
 */
const source = readFileSync(fileURLToPath(new URL("../WorktreeCard.tsx", import.meta.url)), "utf8");

/**
 * The body of whichever handler the two entry points actually route to, comments
 * stripped.
 *
 * Resolved from the callers rather than by name so the assertions can't pass
 * against a correct-but-dead handler, and so a badge and a menu that drifted
 * onto different handlers fail here rather than silently testing one of them.
 * Bounded by the next top-level `const` so reformatting can't truncate the slice
 * to nothing — the `dispatch` assertion is what proves it didn't.
 */
function handlerBody(): string {
  const badge = source.match(/onOpenPlan:\s*([A-Za-z0-9_]+)/)?.[1];
  const menu = source.match(/onViewPlan:\s*([A-Za-z0-9_]+)/)?.[1];
  expect(badge, "the plan badge no longer routes to a named handler").toBeDefined();
  expect(menu, "the View Plan menu item no longer routes to a named handler").toBeDefined();
  expect(badge, "the badge and the context menu open the plan file differently").toBe(menu);

  const start = source.indexOf(`const ${badge} =`);
  expect(start, `${badge} is routed to but never declared`).toBeGreaterThan(-1);
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

describe("WorktreeCard — plan file (#11942)", () => {
  it("opens the generic file viewer rather than a bespoke plan dialog", () => {
    expect(handlerBody()).toContain('"file.view"');
  });

  it("binds the panel to this card's worktree, never an inferred one", () => {
    expect(handlerBody()).toMatch(/worktreeId:\s*worktree\.id/);
  });

  it("resolves the bare plan filename against this worktree's root", () => {
    // `planFilePath` is a candidate filename (`TODO.md` and friends), not a
    // path — without a root it would resolve against the project instead.
    expect(handlerBody()).toMatch(/rootPath:\s*worktree\.path/);
  });

  it("requests the rendered view, which is the whole point of the change", () => {
    expect(handlerBody()).toMatch(/viewMode:\s*"rendered"/);
  });
});
