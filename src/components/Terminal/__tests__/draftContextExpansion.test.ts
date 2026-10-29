// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { formatAgentContextBlock } from "@shared/utils/agentContextDrag";
import type {
  ContextReference,
  ContextReferenceResolution,
} from "@shared/types/pluginContextProvider";
import { listDraftContextTokens, shareContextReferenceResolutions } from "../draftContextExpansion";

describe("listDraftContextTokens", () => {
  it("names each distinct token once, in the order the draft has them", () => {
    expect(
      listDraftContextTokens(
        "@terminal then @diff:staged and @rec:7 and @diff:staged again @selection"
      )
    ).toEqual([
      { text: "@terminal", kind: "terminal" },
      { text: "@diff:staged", kind: "diff" },
      { text: "@rec:7", kind: "plugin" },
      { text: "@selection", kind: "selection" },
    ]);
  });

  it("finds nothing in plain text, an email address, or a handed-off block", () => {
    expect(listDraftContextTokens("send it to me@diff.dev")).toEqual([]);
    const handoff = formatAgentContextBlock({ text: "see @diff", title: "Notes" });
    expect(listDraftContextTokens(`Read this\n${handoff}`)).toEqual([]);
  });
});

describe("shareContextReferenceResolutions", () => {
  const resolved = (id: string): ContextReferenceResolution => ({
    status: "resolved",
    pluginId: "recs",
    pluginName: "Recs",
    text: `record ${id}`,
  });

  it("asks once per reference, however many drafts carry it", async () => {
    const resolve = vi.fn(async (refs: ContextReference[]) => refs.map((ref) => resolved(ref.id)));
    const shared = shareContextReferenceResolutions(resolve);
    const a = { prefix: "rec", id: "1" };
    const b = { prefix: "rec", id: "2" };

    const [first, second] = await Promise.all([shared([a, a, b, b]), shared([b, a])]);

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith([a, b]);
    expect(first).toEqual([resolved("1"), resolved("1"), resolved("2"), resolved("2")]);
    expect(second).toEqual([resolved("2"), resolved("1")]);
  });

  it("asks again only for a reference it hasn't seen", async () => {
    const resolve = vi.fn(async (refs: ContextReference[]) => refs.map((ref) => resolved(ref.id)));
    const shared = shareContextReferenceResolutions(resolve);
    await shared([{ prefix: "rec", id: "1" }]);
    await shared([
      { prefix: "rec", id: "1" },
      { prefix: "doc", id: "1" },
    ]);
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(resolve).toHaveBeenLastCalledWith([{ prefix: "doc", id: "1" }]);
  });

  it("hands every draft the failure when main can't be asked", async () => {
    const resolve = vi.fn(async (): Promise<ContextReferenceResolution[]> => {
      throw new Error("main gone");
    });
    const shared = shareContextReferenceResolutions(resolve);
    const ref = { prefix: "rec", id: "1" };
    await expect(shared([ref])).rejects.toThrow("main gone");
    await expect(shared([ref])).rejects.toThrow("main gone");
    expect(resolve).toHaveBeenCalledTimes(1);
  });
});
