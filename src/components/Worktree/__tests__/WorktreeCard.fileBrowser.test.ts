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
    // Without it the store's ambient guards can resolve `focusPolicy` to
    // "preserve", leaving the panel behind a maximized cell.
    expect(handlerBody()).toMatch(/source: "context-menu"/);
  });
});
