import { describe, expect, it } from "vitest";
import type { TabInfo } from "@/components/Panel/TabButton";
import { reconcileGridTabs } from "../stableGridTabs";

// Every key present, some undefined, as GridTabGroup's builder writes them.
function tab(id: string, fields: Partial<TabInfo> = {}, chrome: Partial<TabInfo["chrome"]> = {}) {
  const built: TabInfo = {
    id,
    title: id,
    fullTitle: id,
    chrome: {
      iconId: "claude",
      color: undefined,
      presetColor: undefined,
      label: "Claude",
      isAgent: true,
      agentId: "claude",
      processId: null,
      runtimeKind: "agent",
      hasExited: false,
      ...chrome,
    },
    kind: "terminal",
    agentState: "working",
    launchAgentId: "claude",
    isActive: false,
    presetColor: undefined,
    isUsingFallback: undefined,
    fallbackTooltip: undefined,
    presetName: undefined,
    hasDangerousFlags: false,
    ...fields,
  };
  return built;
}

const tabFieldChanges: [string, Partial<TabInfo>][] = [
  ["title", { title: "Fix auth" }],
  ["fullTitle", { fullTitle: "Claude: Fix auth" }],
  ["kind", { kind: "browser" }],
  ["agentState", { agentState: "waiting" }],
  ["launchAgentId", { launchAgentId: "codex" }],
  ["isActive", { isActive: true }],
  ["presetColor", { presetColor: "#ff0000" }],
  ["isUsingFallback", { isUsingFallback: true }],
  ["fallbackTooltip", { fallbackTooltip: "Using fallback" }],
  ["presetName", { presetName: "Team" }],
  ["hasDangerousFlags", { hasDangerousFlags: true }],
];

const chromeFieldChanges: [string, Partial<TabInfo["chrome"]>][] = [
  ["iconId", { iconId: "codex" }],
  ["color", { color: "#00ff00" }],
  ["presetColor", { presetColor: "#ff0000" }],
  ["label", { label: "Codex" }],
  ["isAgent", { isAgent: false }],
  ["agentId", { agentId: "codex" }],
  ["processId", { processId: "node" }],
  ["runtimeKind", { runtimeKind: "process" }],
  ["hasExited", { hasExited: true }],
];

describe("reconcileGridTabs", () => {
  it("keeps the previous array when freshly built tabs draw the same", () => {
    const previous = [tab("a", { isActive: true }), tab("b")];
    expect(reconcileGridTabs(previous, [tab("a", { isActive: true }), tab("b")])).toBe(previous);
  });

  it.each(tabFieldChanges)("takes the rebuilt tab when only its %s changed", (_field, change) => {
    const previous = [tab("a"), tab("b"), tab("c")];
    const changed = tab("b", change);
    const next = reconcileGridTabs(previous, [tab("a"), changed, tab("c")]);
    expect(next).not.toBe(previous);
    expect(next[0]).toBe(previous[0]);
    expect(next[1]).toBe(changed);
    expect(next[2]).toBe(previous[2]);
  });

  it.each(chromeFieldChanges)(
    "takes the rebuilt tab when only its chrome's %s changed",
    (_field, change) => {
      const previous = [tab("a")];
      const changed = tab("a", {}, change);
      const next = reconcileGridTabs(previous, [changed]);
      expect(next).not.toBe(previous);
      expect(next[0]).toBe(changed);
    }
  );

  it("returns a new order with the same tab objects", () => {
    const previous = [tab("a"), tab("b")];
    const next = reconcileGridTabs(previous, [tab("b"), tab("a")]);
    expect(next).not.toBe(previous);
    expect(next[0]).toBe(previous[1]);
    expect(next[1]).toBe(previous[0]);
  });

  it("drops a removed tab and keeps the rest", () => {
    const previous = [tab("a"), tab("b")];
    const next = reconcileGridTabs(previous, [tab("a")]);
    expect(next).toEqual([previous[0]]);
    expect(next[0]).toBe(previous[0]);
  });

  it("takes an added tab as built", () => {
    const previous = [tab("a")];
    const added = tab("b");
    const next = reconcileGridTabs(previous, [tab("a"), added]);
    expect(next[0]).toBe(previous[0]);
    expect(next[1]).toBe(added);
  });
});
