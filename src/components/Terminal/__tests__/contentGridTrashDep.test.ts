/**
 * Regression test for issue where trashing a terminal left it visible in the grid.
 *
 * Root cause: the `tabGroups` useMemo in ContentGrid only depended on `storeTerminalIds`,
 * which does NOT change when a terminal is trashed — only `panelsById` and
 * `trashedTerminals` change. This meant the memo stayed stale and the trashed terminal
 * remained rendered.
 *
 * Fix: add `trashedTerminals` to both the useShallow selector and the tabGroups memo deps.
 *
 * ContentDock took a different route — see the second describe block below.
 */

import { describe, it, expect } from "vitest";
import { readFile } from "fs/promises";
import { resolve } from "path";

const CONTEXT_PATH = resolve(__dirname, "../useContentGridContext.tsx");
const DOCK_PATH = resolve(__dirname, "../../Layout/ContentDock.tsx");

describe("ContentGrid tabGroups memo includes trashedTerminals dep (trash-visibility regression)", () => {
  it("selects trashedTerminals from the store", async () => {
    const content = await readFile(CONTEXT_PATH, "utf-8");
    expect(content).toContain("trashedTerminals: state.trashedTerminals");
  });

  it("destructures trashedTerminals from the useShallow selector", async () => {
    const content = await readFile(CONTEXT_PATH, "utf-8");
    expect(content).toMatch(/const\s*\{[^}]*trashedTerminals[^}]*\}\s*=\s*usePanelStore/s);
  });

  it("includes trashedTerminals in the tabGroups memo dependency array", async () => {
    const content = await readFile(CONTEXT_PATH, "utf-8");
    // Find the tabGroups memo block and verify trashedTerminals is in its dep array
    const tabGroupsBlock = content.slice(content.indexOf("const tabGroups = useMemo("));
    // Match the dependency array: }, [deps]) — the bracket after "}, "
    const depsArrayMatch = tabGroupsBlock.match(/\},\s*\[([^\]]+)\]/s);
    expect(depsArrayMatch).not.toBeNull();
    expect(depsArrayMatch![1]).toContain("trashedTerminals");
  });
});

/**
 * ContentDock no longer has a `tabGroups` memo to carry a `trashedTerminals`
 * dep — and that dep never worked there anyway. The renderer compiles with
 * React Compiler in `compilationMode: "infer"` (vite.config.ts), which drops
 * deps the callback never consumes, so the dock memo's `void trashedTerminals`
 * read was eliminated from the compiled cache key along with every other
 * invalidation-only dep. The same elimination is what froze dock chip order
 * after a reorder (#11873).
 *
 * The dock now excludes trashed panels in the narrow store selector that feeds
 * the rail, and derives render items from that selector's output — a value the
 * compiler cannot drop, because the builder genuinely consumes it. These
 * assertions pin that dataflow rather than a dep-array shape.
 */
describe("ContentDock excludes trashed panels through a compiler-safe dataflow", () => {
  it("filters trashed panels out of the ordered dock selector", async () => {
    const content = await readFile(DOCK_PATH, "utf-8");
    const selector = content.slice(content.indexOf("const dockTerminalsRaw = usePanelStore("));
    expect(selector).not.toBe("");
    expect(selector.slice(0, selector.indexOf("\n  );"))).toContain("trashedTerminals");
  });

  it("does not call the tab-group store getters during render", async () => {
    const content = await readFile(DOCK_PATH, "utf-8");
    // `getTabGroups`/`getTabGroupPanels` are store actions: stable references
    // the compiler happily caches against while their hidden state moves under
    // them. Calling one during render is how the rail went stale (#11873) — the
    // dock reads reactive snapshots instead. This is the invariant, so it holds
    // across renames of the values those snapshots are bound to.
    expect(content).not.toMatch(/\bgetTabGroups\(/);
    expect(content).not.toMatch(/\bgetTabGroupPanels\(/);
  });

  it("keeps no invalidation-only reads, which the compiler eliminates", async () => {
    const content = await readFile(DOCK_PATH, "utf-8");
    expect(content).not.toMatch(/^\s*void \w+;\s*$/m);
  });
});
