// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { Terminal as HeadlessTerminal } from "@xterm/headless";
import { formatAgentContextBlock } from "@shared/utils/agentContextDrag";
import type {
  ContextReference,
  ContextReferenceResolution,
} from "@shared/types/pluginContextProvider";

const screen = vi.hoisted(() => ({ terminal: null as null | { dispose(): void } }));
vi.mock("@/services/terminal/terminalInstanceServiceAccessor", () => ({
  peek: () => ({
    get: () => (screen.terminal ? { terminal: screen.terminal } : undefined),
    getCachedSelection: () => undefined,
  }),
}));

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

  it("hands every asker the same failure, before and after it settles", async () => {
    const failures: Array<() => Promise<string>> = [
      async () => {
        throw new Error("rate limited");
      },
      () => {
        throw new Error("no bridge");
      },
    ];
    for (const fail of failures) {
      const read = vi.fn(fail);
      const shared = shareWorkingDiffReads(read);
      const caught = (reading: Promise<string>) => reading.catch((err: unknown) => err);
      const [first, second] = await Promise.all([
        caught(shared("/wt/a", "head")),
        caught(shared("/wt/a", "head")),
      ]);
      const late = await caught(shared("/wt/a", "head"));
      expect(first).toBeInstanceOf(Error);
      expect(second).toBe(first);
      expect(late).toBe(first);
      expect(read).toHaveBeenCalledTimes(1);
    }
  });

  it("starts fresh for each sharer, so the next send reads the diff again", async () => {
    const read = vi.fn(readDiff).mockResolvedValueOnce("+ first").mockResolvedValueOnce("+ second");
    expect(await shareWorkingDiffReads(read)("/wt/a", "unstaged")).toBe("+ first");
    expect(await shareWorkingDiffReads(read)("/wt/a", "unstaged")).toBe("+ second");
  });

  it("reads a draft's repeated @diff once when no reader is handed in", async () => {
    let reads = 0;
    const getWorkingDiff = vi.fn(
      async (cwd: string, type: string) => `${type} in ${cwd} #${++reads}`
    );
    const original = Object.getOwnPropertyDescriptor(window, "electron");
    Object.assign(window, { electron: { git: { getWorkingDiff } } });
    try {
      const out = await expandDraftContext("@diff then @diff:staged then @diff", {
        terminalId: "t1",
        cwd: "/wt/a",
      });
      expect(getWorkingDiff.mock.calls).toEqual([
        ["/wt/a", "unstaged"],
        ["/wt/a", "staged"],
      ]);
      expect(out.split("unstaged in /wt/a #1")).toHaveLength(3);
      expect(out).toContain("staged in /wt/a #2");

      const next = await expandDraftContext("@diff", { terminalId: "t1", cwd: "/wt/a" });
      expect(next).toContain("unstaged in /wt/a #3");
    } finally {
      if (original) Object.defineProperty(window, "electron", original);
      else Reflect.deleteProperty(window, "electron");
    }
  });
});

describe("expandDraftContext @terminal", () => {
  afterEach(() => {
    screen.terminal?.dispose();
    screen.terminal = null;
  });

  async function showing(cols: number, output: string, rows = 10): Promise<void> {
    const terminal = new HeadlessTerminal({ cols, rows, scrollback: 1000, allowProposedApi: true });
    await new Promise<void>((resolve) => terminal.write(output, resolve));
    screen.terminal?.dispose();
    screen.terminal = terminal;
  }

  /** What `@terminal` put between its fences. */
  async function injected(): Promise<string> {
    const expanded = await expandDraftContext("@terminal", { terminalId: "t1", cwd: "/repo" });
    const lines = expanded.split("\n");
    expect(lines[0]).toMatch(/^`{3,}$/);
    expect(lines[lines.length - 1]).toBe(lines[0]);
    return lines.slice(1, -1).join("\n");
  }

  const url = "https://example.com/a/very/long/path/without/any/breaks/index.html?q=1&r=2";

  it("keeps a URL xterm wrapped across rows on one line, at any pane width", async () => {
    const output = `$ cat link\r\n${url}\r\n$ `;
    await showing(24, output);
    const narrow = await injected();
    await showing(160, output);
    const wide = await injected();
    expect(narrow).toBe(`$ cat link\n${url}\n$`);
    expect(wide).toBe(narrow);
  });

  it("keeps a space that fell on the wrap boundary of a command", async () => {
    // At 20 columns the space after the a's is the row's last cell.
    const command = `echo ${"a".repeat(14)} bbbbbb`;
    await showing(20, command);
    expect(await injected()).toBe(command);
    await showing(120, command);
    expect(await injected()).toBe(command);
  });

  it("attaches the same lines at any width, even past a hundred wrapped rows", async () => {
    const lines = Array.from(
      { length: 60 },
      (_, i) => `${String(i).padStart(2, "0")} ${"x".repeat(27)}`
    );
    // Three rows a line at ten columns: 180 rows in all.
    await showing(10, lines.join("\r\n"));
    const narrow = await injected();
    await showing(120, lines.join("\r\n"));
    expect(narrow).toBe(lines.join("\n"));
    expect(await injected()).toBe(narrow);
  });

  it("keeps the line breaks the program wrote", async () => {
    await showing(20, "first line\r\nsecond line\r\n\r\nafter a blank");
    expect(await injected()).toBe("first line\nsecond line\n\nafter a blank");
  });
});
