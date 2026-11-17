import { afterEach, describe, expect, it } from "vitest";
import { hostEnvDrafts, type HostEnvDraft } from "../hostEnvDrafts";

function draft(value: string): HostEnvDraft {
  return {
    rows: [{ id: value, key: "TOKEN", value }],
    base: { record: {}, revision: "r1" },
    movedUnder: false,
  };
}

afterEach(() => hostEnvDrafts.clear());

describe("hostEnvDrafts.firstUnsaved", () => {
  it("passes over a host no longer offered to the one still waiting behind it", () => {
    hostEnvDrafts.set("host-a", draft("a"));
    hostEnvDrafts.set("host-b", draft("b"));
    const offered = new Set(["host-b"]);

    expect(hostEnvDrafts.firstUnsaved((id) => offered.has(id))).toBe("host-b");
    expect(hostEnvDrafts.get("host-b")).toEqual(draft("b"));
  });

  it("holds nothing when no host with an edit is offered", () => {
    hostEnvDrafts.set("host-a", draft("a"));
    expect(hostEnvDrafts.firstUnsaved(() => false)).toBeUndefined();
  });

  it("keeps the order edits were left in", () => {
    hostEnvDrafts.set("host-b", draft("b"));
    hostEnvDrafts.set("host-a", draft("a"));
    expect(hostEnvDrafts.firstUnsaved(() => true)).toBe("host-b");
  });
});
