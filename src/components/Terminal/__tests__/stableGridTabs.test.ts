import { describe, expect, it } from "vitest";
import type { TabInfo } from "@/components/Panel/TabButton";
import { reconcileGridTabs } from "../stableGridTabs";

function tab(id: string, fields: Partial<TabInfo> = {}): TabInfo {
  return {
    id,
    title: id,
    fullTitle: id,
    chrome: {
      iconId: "claude",
      label: "Claude",
      isAgent: true,
      agentId: "claude",
      processId: null,
      runtimeKind: "agent",
      hasExited: false,
    },
    kind: "terminal",
    agentState: "working",
    isActive: false,
    hasDangerousFlags: false,
    ...fields,
  };
}

describe("reconcileGridTabs", () => {
  it("keeps the previous array when freshly built tabs draw the same", () => {
    const previous = [tab("a", { isActive: true }), tab("b")];
    expect(reconcileGridTabs(previous, [tab("a", { isActive: true }), tab("b")])).toBe(previous);
  });

  it("swaps in the changed tab and keeps its unchanged siblings", () => {
    const previous = [tab("a"), tab("b"), tab("c")];
    const changed = tab("b", { title: "Fix auth" });
    const next = reconcileGridTabs(previous, [tab("a"), changed, tab("c")]);
    expect(next).not.toBe(previous);
    expect(next[0]).toBe(previous[0]);
    expect(next[1]).toBe(changed);
    expect(next[2]).toBe(previous[2]);
  });

  it("treats a difference inside the chrome as a change", () => {
    const previous = [tab("a")];
    const recoloured = tab("a");
    recoloured.chrome = { ...recoloured.chrome, presetColor: "#ff0000" };
    const next = reconcileGridTabs(previous, [recoloured]);
    expect(next).not.toBe(previous);
    expect(next[0]).toBe(recoloured);
  });

  it("treats a field one tab has and the other lacks as a change", () => {
    const previous = [tab("a")];
    const next = reconcileGridTabs(previous, [tab("a", { presetName: "Team" })]);
    expect(next).not.toBe(previous);
    expect(next[0]?.presetName).toBe("Team");
  });

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
