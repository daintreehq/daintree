import { describe, it, expect } from "vitest";
import type { AnyToolbarButtonId } from "@shared/types/toolbar";
import {
  getGroupedInsertionIndex,
  getToolbarDividerAfterIds,
  orderToolbarButtonsByGroup,
  type ResolveToolbarButtonGroup,
} from "../toolbarButtonGrouping";
import { getToolbarButtonGroup } from "../toolbarButtonMetadata";

// The real resolver, with nothing registered as a plugin contribution. Tests
// that care about plugin classification pass their own membership set.
const resolve: ResolveToolbarButtonGroup = (id) => getToolbarButtonGroup(id);

const resolveWithPlugins =
  (pluginIds: Set<string>): ResolveToolbarButtonGroup =>
  (id) =>
    getToolbarButtonGroup(id, pluginIds.has(id));

const visibleOnly =
  (visible: AnyToolbarButtonId[]) =>
  (id: AnyToolbarButtonId): boolean =>
    visible.includes(id);

describe("orderToolbarButtonsByGroup", () => {
  it("moves an interleaved layout into launcher, agents, panels, utilities order", () => {
    const ordered = orderToolbarButtonsByGroup(
      ["terminal", "claude", "launcher", "settings", "file-browser", "codex"],
      resolve
    );

    expect(ordered).toEqual([
      "launcher",
      "claude",
      "codex",
      "terminal",
      "file-browser",
      "settings",
    ]);
  });

  it("preserves the user's relative order inside each group", () => {
    const ordered = orderToolbarButtonsByGroup(
      ["codex", "terminal", "claude", "file-browser"],
      resolve
    );

    // codex before claude, terminal before file-browser — as the user had them.
    expect(ordered).toEqual(["codex", "claude", "terminal", "file-browser"]);
  });

  it("keeps every input id exactly once", () => {
    const input: AnyToolbarButtonId[] = ["settings", "claude", "browser", "launcher", "dev-server"];

    const ordered = orderToolbarButtonsByGroup(input, resolve);

    expect([...ordered].sort()).toEqual([...input].sort());
  });

  it("is idempotent — regrouping an already grouped list changes nothing", () => {
    const once = orderToolbarButtonsByGroup(["terminal", "claude", "launcher"], resolve);

    expect(orderToolbarButtonsByGroup(once, resolve)).toEqual(once);
  });

  it("returns an empty list unchanged", () => {
    expect(orderToolbarButtonsByGroup([], resolve)).toEqual([]);
  });

  it("sorts by live registry membership, not by the id alone", () => {
    // `settings` is unclassified (utilities) and `terminal` is a declared
    // panel, so panels normally win the lead regardless of input order.
    const ids: AnyToolbarButtonId[] = ["settings", "terminal"];
    expect(orderToolbarButtonsByGroup(ids, resolveWithPlugins(new Set()))).toEqual([
      "terminal",
      "settings",
    ]);

    // Flagging `terminal` as a live contribution demotes it to utilities, where
    // it shares a group with `settings` and the input order stands. The same
    // ids, a different result — so the membership argument genuinely reaches
    // the ordering and the plugin branch can't be dropped.
    expect(orderToolbarButtonsByGroup(ids, resolveWithPlugins(new Set(["terminal"])))).toEqual([
      "settings",
      "terminal",
    ]);
  });
});

describe("getToolbarDividerAfterIds", () => {
  it("marks the last visible member of each group but never the final one", () => {
    const ordered: AnyToolbarButtonId[] = ["launcher", "claude", "codex", "terminal", "settings"];

    const dividerAfter = getToolbarDividerAfterIds(ordered, () => true, resolve);

    // launcher│agents│panels│utilities — three boundaries, no trailing divider.
    expect([...dividerAfter]).toEqual(["launcher", "codex", "terminal"]);
  });

  it("draws nothing when every visible button shares one group", () => {
    const dividerAfter = getToolbarDividerAfterIds(
      ["claude", "codex", "gemini"],
      () => true,
      resolve
    );

    expect(dividerAfter.size).toBe(0);
  });

  it("moves the divider to the last still-visible member when one overflows", () => {
    const ordered: AnyToolbarButtonId[] = ["launcher", "claude", "codex", "terminal"];

    // codex was evicted into the overflow menu.
    const dividerAfter = getToolbarDividerAfterIds(
      ordered,
      visibleOnly(["launcher", "claude", "terminal"]),
      resolve
    );

    expect(dividerAfter.has("claude")).toBe(true);
    expect(dividerAfter.has("codex")).toBe(false);
  });

  it("collapses to one divider when an entire middle group overflows", () => {
    const ordered: AnyToolbarButtonId[] = ["launcher", "claude", "codex", "terminal"];

    const dividerAfter = getToolbarDividerAfterIds(
      ordered,
      visibleOnly(["launcher", "terminal"]),
      resolve
    );

    expect([...dividerAfter]).toEqual(["launcher"]);
  });

  it("draws no divider when only one button is visible", () => {
    const dividerAfter = getToolbarDividerAfterIds(
      ["launcher", "claude", "terminal"],
      visibleOnly(["claude"]),
      resolve
    );

    expect(dividerAfter.size).toBe(0);
  });

  it("draws no divider when nothing is visible", () => {
    const dividerAfter = getToolbarDividerAfterIds(
      ["launcher", "claude", "terminal"],
      () => false,
      resolve
    );

    expect(dividerAfter.size).toBe(0);
  });

  it("never marks a hidden button, so an evicted id cannot strand a divider", () => {
    const ordered: AnyToolbarButtonId[] = ["launcher", "claude", "terminal"];

    const dividerAfter = getToolbarDividerAfterIds(
      ordered,
      visibleOnly(["launcher", "claude"]),
      resolve
    );

    expect(dividerAfter.has("terminal")).toBe(false);
    // agents is now the trailing visible group, so its boundary disappears too.
    expect([...dividerAfter]).toEqual(["launcher"]);
  });
});

describe("getGroupedInsertionIndex", () => {
  it("anchors after the preceding same-group peer in the stored array", () => {
    // Stored order is interleaved; the projection the user saw is grouped.
    const raw: AnyToolbarButtonId[] = ["terminal", "claude", "file-browser"];
    const projected: AnyToolbarButtonId[] = ["claude", "codex", "terminal", "file-browser"];

    const index = getGroupedInsertionIndex(raw, projected, "codex", resolve);

    // Straight after `claude` in the raw array, so grouping yields claude→codex.
    expect(index).toBe(2);
    const spliced = [...raw];
    spliced.splice(index, 0, "codex");
    expect(orderToolbarButtonsByGroup(spliced, resolve)).toEqual(projected);
  });

  it("anchors before the following peer when the button was dropped first in its group", () => {
    const raw: AnyToolbarButtonId[] = ["terminal", "claude"];
    const projected: AnyToolbarButtonId[] = ["codex", "claude", "terminal"];

    const index = getGroupedInsertionIndex(raw, projected, "codex", resolve);

    expect(index).toBe(1);
    const spliced = [...raw];
    spliced.splice(index, 0, "codex");
    expect(orderToolbarButtonsByGroup(spliced, resolve)).toEqual(projected);
  });

  it("appends when the button has no peers in its group", () => {
    const raw: AnyToolbarButtonId[] = ["claude", "codex"];
    const projected: AnyToolbarButtonId[] = ["claude", "codex", "terminal"];

    expect(getGroupedInsertionIndex(raw, projected, "terminal", resolve)).toBe(raw.length);
  });

  it("round-trips the drop position through a legacy interleaved array", () => {
    const raw: AnyToolbarButtonId[] = ["terminal", "claude", "settings", "codex"];
    // The user dropped `gemini` between claude and codex in the grouped column.
    const projected: AnyToolbarButtonId[] = ["claude", "gemini", "codex", "terminal", "settings"];

    const index = getGroupedInsertionIndex(raw, projected, "gemini", resolve);
    const spliced = [...raw];
    spliced.splice(index, 0, "gemini");

    expect(orderToolbarButtonsByGroup(spliced, resolve)).toEqual(projected);
  });
});
