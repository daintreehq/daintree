// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { formatAgentContextBlock } from "@shared/utils/agentContextDrag";
import type {
  ContextReference,
  ContextReferenceResolution,
} from "@shared/types/pluginContextProvider";
import {
  expandDraftContext,
  listDraftContextTokens,
  shareContextReferenceResolutions,
  shareWorkingDiffReads,
} from "../draftContextExpansion";

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

  it("names @notes and each per-file form as notes, so a fleet previews and refuses them", () => {
    expect(listDraftContextTokens('@notes and @notes:src/a.ts and @notes:"my file.ts"')).toEqual([
      { text: "@notes", kind: "notes" },
      { text: "@notes:src/a.ts", kind: "notes" },
      { text: '@notes:"my file.ts"', kind: "notes" },
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

describe("shareWorkingDiffReads (#17480)", () => {
  const readDiff = async (cwd: string, type: string) => `diff ${type} in ${cwd}`;

  it("reads once per working directory and diff type, however many ask", async () => {
    const read = vi.fn(readDiff);
    const shared = shareWorkingDiffReads(read);

    const answers = await Promise.all([
      shared("/wt/a", "unstaged"),
      shared("/wt/a", "unstaged"),
      shared("/wt/a", "staged"),
      shared("/wt/b", "unstaged"),
    ]);
    await shared("/wt/a", "unstaged");

    expect(read.mock.calls).toEqual([
      ["/wt/a", "unstaged"],
      ["/wt/a", "staged"],
      ["/wt/b", "unstaged"],
    ]);
    expect(answers).toEqual([
      "diff unstaged in /wt/a",
      "diff unstaged in /wt/a",
      "diff staged in /wt/a",
      "diff unstaged in /wt/b",
    ]);
  });

  it("hands every asker the failure, whether the read rejects or throws", async () => {
    const rejecting = vi.fn(async (): Promise<string> => {
      throw new Error("rate limited");
    });
    const throwing = vi.fn((): Promise<string> => {
      throw new Error("no bridge");
    });
    const viaReject = shareWorkingDiffReads(rejecting);
    const viaThrow = shareWorkingDiffReads(throwing);
    for (const shared of [viaReject, viaThrow]) {
      const first = shared("/wt/a", "head");
      const second = shared("/wt/a", "head");
      await expect(first).rejects.toThrow();
      await expect(second).rejects.toThrow();
    }
    expect(rejecting).toHaveBeenCalledTimes(1);
    expect(throwing).toHaveBeenCalledTimes(1);
  });

  it("starts fresh for each sharer, so the next send reads the diff again", async () => {
    const read = vi.fn(readDiff);
    await shareWorkingDiffReads(read)("/wt/a", "unstaged");
    await shareWorkingDiffReads(read)("/wt/a", "unstaged");
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("reads a draft's repeated @diff once when no reader is handed in", async () => {
    const getWorkingDiff = vi.fn(readDiff);
    (window as unknown as { electron: unknown }).electron = { git: { getWorkingDiff } };

    const out = await expandDraftContext("@diff then @diff:staged then @diff", {
      terminalId: "t1",
      cwd: "/wt/a",
    });

    expect(getWorkingDiff.mock.calls).toEqual([
      ["/wt/a", "unstaged"],
      ["/wt/a", "staged"],
    ]);
    expect(out.split("diff unstaged in /wt/a")).toHaveLength(3);
    expect(out).toContain("diff staged in /wt/a");

    await expandDraftContext("@diff", { terminalId: "t1", cwd: "/wt/a" });
    expect(getWorkingDiff).toHaveBeenCalledTimes(3);
  });
});
