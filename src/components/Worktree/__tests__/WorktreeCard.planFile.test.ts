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
 * the card's OWN worktree and rendered by default (#11942). `file.view` falls
 * back to the active worktree when none is named, and that binding is what
 * decides the pane's read root and which bucket a promotion lands in — so a card
 * that is not the selected one must name itself explicitly.
 */
const source = readFileSync(fileURLToPath(new URL("../WorktreeCard.tsx", import.meta.url)), "utf8");

/**
 * The body of `openPlanFileForThisWorktree`, comments stripped.
 *
 * Bounded by the next top-level `const` rather than a literal closing brace so
 * reformatting the handler doesn't silently truncate it to nothing — the
 * `dispatch` assertion here is what keeps every caller below on a real slice.
 */
function handlerBody(): string {
  const start = source.indexOf("const openPlanFileForThisWorktree");
  expect(start, "openPlanFileForThisWorktree is gone or was renamed").toBeGreaterThan(-1);
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
    const body = handlerBody();
    expect(body).toContain('"file.view"');
    // The card-local dialog state the generic viewer replaced. Left anywhere in
    // the file it would mean a half-reverted refactor, so this looks at the
    // whole source and not just the handler.
    expect(source).not.toContain("showPlanViewer");
    expect(source).not.toContain("PlanFileViewer");
  });

  it("binds the panel to this card's worktree, never the active one", () => {
    const body = handlerBody();
    expect(body).toMatch(/worktreeId:\s*worktree\.id/);
  });

  it("resolves the bare plan filename against this worktree's root", () => {
    const body = handlerBody();
    // `planFilePath` is a candidate filename (`TODO.md` and friends), not a
    // path — without a root it would resolve against the project instead.
    expect(body).toMatch(/rootPath:\s*worktree\.path/);
  });

  it("requests the rendered view, which is the whole point of the change", () => {
    expect(handlerBody()).toMatch(/viewMode:\s*"rendered"/);
  });

  it("withholds the handler when the worktree has no plan file to open", () => {
    const body = handlerBody();
    // Both halves matter: `hasPlanFile` is the detection flag the badge reads,
    // and the path is what the dispatch actually needs. Either one alone leaves
    // an entry point that opens a dialog on nothing.
    expect(body).toContain("hasPlanFile");
    expect(body).toMatch(/planFilePath/);
    expect(body).toContain("undefined");
  });

  it("routes the badge and the context menu through the same handler", () => {
    // Two entry points that drifted apart is how one of them ends up still
    // opening the old surface, or opening it unbound.
    const badge = source.match(/onOpenPlan:\s*([A-Za-z0-9_]+)/);
    const menu = source.match(/onViewPlan:\s*([A-Za-z0-9_]+)/);
    expect(badge?.[1], "the plan badge no longer routes to a named handler").toBeDefined();
    expect(menu?.[1], "the View Plan menu item no longer routes to a named handler").toBeDefined();
    expect(badge?.[1]).toBe(menu?.[1]);
  });
});
