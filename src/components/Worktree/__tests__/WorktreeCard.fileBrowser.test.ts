import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Source contract rather than a render: WorktreeCard pulls in the whole
 * worktree/panel/agent store graph, and what needs pinning here is one
 * ordering — select, then dispatch — that a render assertion would only reach
 * through a fixture larger than the rule it protects.
 *
 * The rule: the card's Browse Files entry opens a real grid panel, and the grid
 * renders only the active worktree's bucket. Dispatching for an inactive card
 * without selecting it first creates a panel that is counted, persisted, and
 * invisible (#11666).
 */
const source = readFileSync(fileURLToPath(new URL("../WorktreeCard.tsx", import.meta.url)), "utf8");

/**
 * The body of `openFileBrowserForThisWorktree`, comments stripped.
 *
 * Bounded by the next top-level `const` rather than a literal closing brace so
 * reformatting the handler doesn't silently truncate it to nothing — and every
 * assertion below runs against a non-empty slice for the same reason.
 */
function handlerBody(): string {
  const start = source.indexOf("const openFileBrowserForThisWorktree");
  expect(start, "openFileBrowserForThisWorktree is gone or was renamed").toBeGreaterThan(-1);
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

describe("WorktreeCard — Browse Files (#11666)", () => {
  it("opens the persistent panel rather than the throwaway dialog", () => {
    const body = handlerBody();
    expect(body).toContain('"worktree.openFileBrowserPanel"');
    expect(body).not.toContain('"worktree.openFileBrowser"');
  });

  it("selects an inactive card before dispatching, so the panel isn't backgrounded", () => {
    const body = handlerBody();
    const select = body.indexOf("onSelect()");
    expect(select, "the card no longer selects itself before opening the browser").toBeGreaterThan(
      -1
    );
    // Guarded, matching `handleTerminalSelect`: re-selecting the active card
    // would re-persist the restore target and touch the MRU for nothing.
    expect(body).toMatch(/!isActive/);
    // Ordering is the whole point: selecting after the dispatch would leave
    // `addPanel` reading the outgoing worktree and backgrounding the panel.
    expect(select).toBeLessThan(body.indexOf("actionService.dispatch"));
  });

  it("names a foreground source so the panel takes focus", () => {
    // Without one the store's ambient guards can resolve `focusPolicy` to
    // "preserve", leaving the panel behind a maximized cell. Which foreground
    // source is not the point — that it is one of them is.
    expect(handlerBody()).toMatch(/source: "(user|keybinding|menu|context-menu)"/);
  });
});

/**
 * The plan file opens through the generic `file.view` dialog, bound to the
 * card's OWN worktree (#11942). Left unnamed, `file.view` resolves the binding
 * from the path, and that answer decides the pane's read root and which grid
 * bucket a promotion lands in. What needs pinning is which arguments the card
 * hands the dispatch, for the same reason as Browse Files above.
 *
 * The body of whichever handler the two entry points actually route to, comments
 * stripped.
 *
 * Resolved from the callers rather than by name so the assertions can't pass
 * against a correct-but-dead handler, and so a badge and a menu that drifted
 * onto different handlers fail here rather than silently testing one of them.
 * Bounded by the next top-level `const` so reformatting can't truncate the slice
 * to nothing — the `dispatch` assertion is what proves it didn't.
 */
function planHandlerBody(): string {
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
    expect(planHandlerBody()).toContain('"file.view"');
  });

  it("binds the panel to this card's worktree, never an inferred one", () => {
    expect(planHandlerBody()).toMatch(/worktreeId:\s*worktree\.id/);
  });

  it("resolves the bare plan filename against this worktree's root", () => {
    // `planFilePath` is a candidate filename (`TODO.md` and friends), not a
    // path — without a root it would resolve against the project instead.
    expect(planHandlerBody()).toMatch(/rootPath:\s*worktree\.path/);
  });

  it("requests the rendered view, which is the whole point of the change", () => {
    expect(planHandlerBody()).toMatch(/viewMode:\s*"rendered"/);
  });
});

/**
 * Source contract rather than a render, like the `file.view` block above: what
 * needs pinning is which ARGUMENTS the card hands a dispatch, and that it adds
 * nothing after it.
 *
 * The rule: the git actions report their own failure, recovery and all
 * (#16667), so the card's push, pull-rebase and force-push rows only dispatch.
 * A toast here too would report one rejection twice, and the recovery routing
 * the card used to own is pinned on the actions now
 * (`gitActions.remoteFailure.test.ts`).
 *
 * The git dispatch helper's body, comments stripped.
 */
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

describe("WorktreeCard — git rows (#12090, #16667)", () => {
  it("hands the git actions this card's path", () => {
    expect(dispatchBody()).toMatch(/\{\s*cwd:\s*worktree\.path\s*\}/);
  });

  it("leaves failure reporting to the action, so a rejection toasts once", () => {
    const body = dispatchBody();
    // The helper fires the dispatch and drops it. Any read of its outcome is
    // the start of a second report, whatever it is spelled as.
    expect(body).toMatch(/void actionService\.dispatch\(/);
    expect(body).not.toMatch(/\bnotify\b|\.then\b|\bawait\b|\bresult\b/);
  });
});
