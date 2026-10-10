// @vitest-environment jsdom
import { createElement, createRef, useState, type ReactNode } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { EditorView } from "@codemirror/view";

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn(() => Promise.resolve({ ok: true })) },
}));

import * as kit from "@daintreehq/plugin-ui";
import type { CodeEditorHandle, DiffHunk } from "@daintreehq/plugin-ui";
import { TooltipProvider } from "@/components/ui/tooltip";
import { findLanguage } from "@/components/PluginKit/kitCodeEditor";
import { normalizePatch } from "@/components/PluginKit/kitDiffView";
import { applyMarkdownEdit, formatMarkdown } from "@/components/PluginKit/kitMarkdownFormat";

beforeAll(async () => {
  await kit.whenPluginUiReady();
  // The editor's preview is the kit's lazy Markdown: loaded here, so a busy CI
  // worker's cold import never eats a waitFor's budget.
  await import("@/components/Markdown/PluginMarkdown");
});

afterEach(cleanup);

function untyped(name: string, props: Record<string, unknown>, ...children: ReactNode[]) {
  return createElement(Reflect.get(kit, name), props, ...children);
}

function withTooltips(children: ReactNode) {
  return createElement(TooltipProvider, null, children);
}

async function editorIn(root: HTMLElement): Promise<EditorView> {
  const content = await waitFor(() => {
    const found = root.querySelector<HTMLElement>(".cm-content");
    if (!found) throw new Error("editor not mounted");
    return found;
  });
  const view = EditorView.findFromDOM(content);
  if (!view) throw new Error("no EditorView");
  return view;
}

describe("CodeEditor", () => {
  it("holds its place with a skeleton, then mounts the host editor on the text", async () => {
    render(createElement(kit.CodeEditor, { value: "a: 1\nb: 2", "data-testid": "ed" }));
    const root = screen.getByTestId("ed");
    const view = await editorIn(root);
    expect(view.state.doc.toString()).toBe("a: 1\nb: 2");
    expect(root.querySelector('[role="status"]')).toBeNull();
    expect(root.querySelector(".cm-gutters")).not.toBeNull();
  });

  it("reports edits and takes a new value without echoing it back", async () => {
    const onChange = vi.fn();
    const { rerender } = render(
      createElement(kit.CodeEditor, { value: "one", onChange, "data-testid": "ed" })
    );
    const view = await editorIn(screen.getByTestId("ed"));
    act(() => view.dispatch({ changes: { from: 3, insert: "!" } }));
    expect(onChange).toHaveBeenLastCalledWith("one!");
    onChange.mockClear();
    rerender(createElement(kit.CodeEditor, { value: "two", onChange, "data-testid": "ed" }));
    expect(view.state.doc.toString()).toBe("two");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("is read-only, unnumbered and named when asked", async () => {
    render(
      createElement(kit.CodeEditor, {
        value: "x",
        readOnly: true,
        lineNumbers: false,
        "aria-label": "config.yaml",
        "data-testid": "ed",
      })
    );
    const root = screen.getByTestId("ed");
    const view = await editorIn(root);
    expect(view.state.readOnly).toBe(true);
    expect(view.contentDOM.getAttribute("aria-readonly")).toBe("true");
    expect(view.contentDOM.getAttribute("aria-label")).toBe("config.yaml");
    expect(root.querySelector(".cm-gutters")).toBeNull();
  });

  it("saves on Cmd+S with the text and keeps the key from the app", async () => {
    const onSave = vi.fn();
    const outer = vi.fn();
    render(
      createElement(
        "div",
        { onKeyDown: outer },
        createElement(kit.CodeEditor, { defaultValue: "draft", onSave, "data-testid": "ed" })
      )
    );
    const view = await editorIn(screen.getByTestId("ed"));
    fireEvent.keyDown(view.contentDOM, { key: "s", metaKey: true });
    fireEvent.keyDown(view.contentDOM, { key: "s", ctrlKey: true });
    expect(onSave).toHaveBeenCalledWith("draft");
    expect(onSave).toHaveBeenCalledTimes(2);
    expect(outer).not.toHaveBeenCalled();
  });

  it("leaves Cmd+S alone without an onSave", async () => {
    const outer = vi.fn();
    render(
      createElement(
        "div",
        { onKeyDown: outer },
        createElement(kit.CodeEditor, { defaultValue: "x", "data-testid": "ed" })
      )
    );
    const view = await editorIn(screen.getByTestId("ed"));
    fireEvent.keyDown(view.contentDOM, { key: "s", metaKey: true });
    expect(outer).toHaveBeenCalledTimes(1);
  });

  it("opens its find bar through the ref", async () => {
    const ref = createRef<CodeEditorHandle>();
    render(createElement(kit.CodeEditor, { value: "needle", ref, "data-testid": "ed" }));
    const root = screen.getByTestId("ed");
    await editorIn(root);
    act(() => ref.current?.openSearch());
    expect(root.querySelector(".cm-search")).not.toBeNull();
    // The panel is the app's search field, not CodeMirror's bare input.
    expect(root.querySelector(".cm-search .search-field")).not.toBeNull();
  });

  it("answers the app's find event only while it has focus", async () => {
    render(createElement(kit.CodeEditor, { value: "needle", "data-testid": "ed" }));
    const root = screen.getByTestId("ed");
    const view = await editorIn(root);
    act(() => void window.dispatchEvent(new CustomEvent("daintree:find-in-panel")));
    expect(root.querySelector(".cm-search")).toBeNull();
    const focused = vi.spyOn(view, "hasFocus", "get").mockReturnValue(true);
    act(() => void window.dispatchEvent(new CustomEvent("daintree:find-in-panel")));
    focused.mockRestore();
    expect(root.querySelector(".cm-search")).not.toBeNull();
  });

  it("keeps an open find bar's replace row in step with readOnly", async () => {
    const ref = createRef<CodeEditorHandle>();
    const { rerender } = render(
      createElement(kit.CodeEditor, { value: "needle", ref, "data-testid": "ed" })
    );
    const root = screen.getByTestId("ed");
    await editorIn(root);
    act(() => ref.current?.openSearch());
    const replace = () => root.querySelector<HTMLInputElement>(".cm-search input[name=replace]");
    replace()!.focus();
    rerender(
      createElement(kit.CodeEditor, { value: "needle", ref, readOnly: true, "data-testid": "ed" })
    );
    expect(replace()).toBeNull();
    // The keyboard was in the row that went: it is handed to the find field.
    expect(document.activeElement?.getAttribute("main-field")).toBe("true");
    rerender(createElement(kit.CodeEditor, { value: "needle", ref, "data-testid": "ed" }));
    expect(replace()).not.toBeNull();
  });

  it("lifts the caret's line in the gutter, as the file viewer does", async () => {
    render(createElement(kit.CodeEditor, { value: "a\nb", "data-testid": "ed" }));
    const root = screen.getByTestId("ed");
    await editorIn(root);
    expect(root.querySelector(".cm-activeLineGutter")).not.toBeNull();
  });

  it("takes a CRLF value with the caret past its normalised length", async () => {
    const { rerender } = render(
      createElement(kit.CodeEditor, { value: "abcd", "data-testid": "ed" })
    );
    const view = await editorIn(screen.getByTestId("ed"));
    act(() => view.dispatch({ selection: { anchor: 4 } }));
    rerender(createElement(kit.CodeEditor, { value: "x\r\ny", "data-testid": "ed" }));
    expect(view.state.doc.toString()).toBe("x\ny");
    expect(view.state.selection.main.head).toBe(3);
  });

  it("ignores values off the contract", async () => {
    render(
      untyped("CodeEditor", {
        value: 42,
        defaultValue: "fallback",
        maxHeight: -3,
        minHeight: "tall",
        language: { name: "json" },
        onChange: "nope",
        "data-testid": "ed",
      })
    );
    const root = screen.getByTestId("ed");
    const view = await editorIn(root);
    expect(view.state.doc.toString()).toBe("fallback");
    expect(root.style.maxHeight).toBe("");
    expect(root.style.minHeight).toBe("");
  });

  it("resolves languages by name, alias and extension", () => {
    expect(findLanguage("json")?.name).toBe("JSON");
    expect(findLanguage("yml")?.name).toBe("YAML");
    expect(findLanguage("ts")?.name).toBe("TypeScript");
    expect(findLanguage("Python")?.name).toBe("Python");
    expect(findLanguage("markdown")?.name).toBe("Markdown");
    expect(findLanguage("not-a-language")).toBeNull();
    expect(findLanguage("  ")).toBeNull();
  });
});

const SAVED = [
  "name: studio",
  "port: 8080",
  "debug: false",
  "a",
  "b",
  "c",
  "d",
  "tail: 1",
  "",
].join("\n");
const EDITED = SAVED.replace("port: 8080", "port: 9090").replace("tail: 1", "tail: 2");

async function loadedDiff(testId: string): Promise<HTMLElement> {
  return waitFor(() => {
    const root = screen.getByTestId(testId);
    if (!root.hasAttribute("data-kit-diff-view")) throw new Error("diff chunk not in yet");
    return root;
  });
}

async function hunkHeaders(root: HTMLElement): Promise<HTMLElement[]> {
  return waitFor(() => {
    const headers = Array.from(root.querySelectorAll<HTMLElement>(".diff-hunk-header-inner"));
    if (headers.length === 0) throw new Error("no hunks yet");
    return headers;
  });
}

describe("DiffView", () => {
  it("diffs two texts through the host viewer, one header per hunk", async () => {
    render(
      withTooltips(
        createElement(kit.DiffView, {
          oldText: SAVED,
          newText: EDITED,
          context: 1,
          path: "studio.yaml",
          "data-testid": "diff",
        })
      )
    );
    const root = await loadedDiff("diff");
    const headers = await hunkHeaders(root);
    expect(headers).toHaveLength(2);
    expect(root.querySelector(".diff-viewer")).not.toBeNull();
    expect(root.getAttribute("aria-label")).toBe("Changes to studio.yaml");
    expect(root.dataset.view).toBe("unified");
    // The host's per-file Open button needs a worktree; a plugin diff has none.
    expect(screen.queryByRole("button", { name: /^Open/ })).toBeNull();
  });

  it("puts hunk actions in each header and hands the pressed hunk back", async () => {
    const onHunkAction = vi.fn<(id: string, hunk: DiffHunk) => void>();
    render(
      withTooltips(
        untyped("DiffView", {
          oldText: SAVED,
          newText: EDITED,
          context: 1,
          hunkActions: [
            { id: "revert", label: "Revert", icon: "rotate-ccw" },
            { id: "revert", label: "Duplicate id" },
            { id: "", label: "No id" },
            "junk",
          ],
          onHunkAction,
          "data-testid": "diff",
        })
      )
    );
    const root = await loadedDiff("diff");
    await hunkHeaders(root);
    const buttons = screen.getAllByRole("button", { name: "Revert" });
    expect(buttons).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Duplicate id" })).toBeNull();
    fireEvent.click(buttons[1]!);
    const [id, hunk] = onHunkAction.mock.calls[0]!;
    expect(id).toBe("revert");
    expect(hunk.index).toBe(1);
    expect(hunk.newText).toContain("tail: 2");
    expect(hunk.oldText).toContain("tail: 1");
    expect(hunk.patch).toMatch(/^diff --git a\/ b\/\n--- a\/\n\+\+\+ b\/\n@@ -/);
    // Undoing the pressed hunk brings back that line alone.
    const reverted = kit.revertHunk(EDITED, hunk);
    expect(reverted).toBe(EDITED.replace("tail: 2", "tail: 1"));
  });

  it("asks a function for each hunk's actions and draws renderHunkActions after them", async () => {
    render(
      withTooltips(
        createElement(kit.DiffView, {
          oldText: SAVED,
          newText: EDITED,
          context: 1,
          hunkActions: (hunk: DiffHunk) =>
            hunk.index === 0 ? [{ id: "stage", label: "Stage" }] : [],
          renderHunkActions: (hunk: DiffHunk) =>
            createElement("span", { "data-testid": `custom-${hunk.index}` }, "note"),
          "data-testid": "diff",
        })
      )
    );
    await hunkHeaders(await loadedDiff("diff"));
    expect(screen.getAllByRole("button", { name: "Stage" })).toHaveLength(1);
    expect(screen.getByTestId("custom-0")).toBeDefined();
    expect(screen.getByTestId("custom-1")).toBeDefined();
  });

  it("reports true counts for a pure insertion and a pure deletion, so they revert", async () => {
    const before = "a\ngone\nb\n";
    const after = "a\nb\nnew\n";
    const onHunkAction = vi.fn<(id: string, hunk: DiffHunk) => void>();
    render(
      withTooltips(
        createElement(kit.DiffView, {
          oldText: before,
          newText: after,
          context: 0,
          hunkActions: [{ id: "revert", label: "Revert" }],
          onHunkAction,
          "data-testid": "diff",
        })
      )
    );
    await hunkHeaders(await loadedDiff("diff"));
    const buttons = screen.getAllByRole("button", { name: "Revert" });
    expect(buttons).toHaveLength(2);
    for (const button of buttons) fireEvent.click(button);
    const [deletion, insertion] = onHunkAction.mock.calls.map((call) => call[1]);
    expect([deletion!.oldCount, deletion!.newCount]).toEqual([1, 0]);
    expect([insertion!.oldCount, insertion!.newCount]).toEqual([0, 1]);
    expect(insertion!.patch).toContain("@@ -3,0 +3,1 @@");
    // Undone one after the other, bottom first, the pair give back the original.
    const reverted = kit.revertHunk(kit.revertHunk(after, insertion!) ?? "", deletion!);
    expect(reverted).toBe(before);
  });

  it("hands the keyboard to the next hunk's action when a Revert removes its own hunk", async () => {
    function Reverting() {
      const [text, setText] = useState(EDITED);
      return createElement(kit.DiffView, {
        oldText: SAVED,
        newText: text,
        context: 1,
        hunkActions: [{ id: "revert", label: "Revert" }],
        onHunkAction: (_id: string, hunk: DiffHunk) => setText(kit.revertHunk(text, hunk) ?? text),
        "data-testid": "diff",
      });
    }
    render(withTooltips(createElement(Reverting)));
    await hunkHeaders(await loadedDiff("diff"));
    const [first] = screen.getAllByRole("button", { name: "Revert" });
    first!.focus();
    act(() => first!.click());
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Revert" })).toHaveLength(1));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Revert" }));
  });

  it("keeps the keyboard in the diff when a Revert removes the last hunk", async () => {
    function Reverting() {
      const [text, setText] = useState("a\nnew\n");
      return createElement(kit.DiffView, {
        oldText: "a\n",
        newText: text,
        hunkActions: [{ id: "revert", label: "Revert" }],
        onHunkAction: (_id: string, hunk: DiffHunk) => setText(kit.revertHunk(text, hunk) ?? text),
        "data-testid": "diff",
      });
    }
    render(withTooltips(createElement(Reverting)));
    const root = await loadedDiff("diff");
    await hunkHeaders(root);
    const button = screen.getByRole("button", { name: "Revert" });
    button.focus();
    act(() => button.click());
    await screen.findByText("No changes detected");
    await waitFor(() => expect(document.activeElement).toBe(root));
  });

  it("keeps the keyboard on the hunk header after expanding hidden lines", async () => {
    render(
      withTooltips(
        createElement(kit.DiffView, {
          oldText: SAVED,
          newText: EDITED,
          context: 1,
          "data-testid": "diff",
        })
      )
    );
    const root = await loadedDiff("diff");
    await hunkHeaders(root);
    const expand = screen.getAllByRole("button", { name: /^Expand/ })[0]!;
    expand.focus();
    act(() => expand.click());
    await waitFor(() => expect(expand.isConnected).toBe(false));
    expect(root.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(document.body);
  });

  it("follows the expanded hunk when expanding merges it with the one above", async () => {
    const lines = Array.from({ length: 20 }, (_, n) => `line ${n + 1}`);
    const before = [...lines, ""].join("\n");
    const after = [
      ...lines.map((line, n) => ([2, 6, 14].includes(n) ? `${line} changed` : line)),
      "",
    ].join("\n");
    render(
      withTooltips(
        createElement(kit.DiffView, {
          oldText: before,
          newText: after,
          context: 1,
          "data-testid": "diff",
        })
      )
    );
    const root = await loadedDiff("diff");
    const headers = await hunkHeaders(root);
    // Three hunks, plus the trailing expander's row to the end of the file.
    expect(headers).toHaveLength(4);
    // The second hunk's expander fills the one-line gap to the first, merging them.
    const expand = headers[1]!.querySelector("button")!;
    expand.focus();
    act(() => expand.click());
    await waitFor(() => expect(root.querySelectorAll(".diff-hunk-header-inner")).toHaveLength(3));
    const now = Array.from(root.querySelectorAll(".diff-hunk-header-inner"));
    // On the merged hunk's header, never the unrelated third hunk's.
    expect(now.indexOf(document.activeElement!.closest(".diff-hunk-header-inner")!)).toBe(0);
  });

  it("drops a custom hunk node React cannot render", async () => {
    render(
      withTooltips(
        untyped("DiffView", {
          oldText: SAVED,
          newText: EDITED,
          renderHunkActions: () => ({ label: "not a node" }),
          "data-testid": "diff",
        })
      )
    );
    const headers = await hunkHeaders(await loadedDiff("diff"));
    expect(headers[0]!.querySelector(".diff-hunk-header-actions")).toBeNull();
  });

  it("rewrites diff -u headers, timestamps and several files into git's form", () => {
    const plain = [
      "--- old.txt\t2026-09-30 10:00:00",
      "+++ new.txt\t2026-09-30 11:00:00",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "--- /dev/null",
      "+++ added.txt",
      "@@ -0,0 +1 @@",
      "+c",
      "",
    ].join("\n");
    const normalized = normalizePatch(plain, undefined);
    expect(normalized).toContain("diff --git a/new.txt b/new.txt\n--- a/old.txt\n+++ b/new.txt\n");
    expect(normalized).toContain(
      "diff --git a/added.txt b/added.txt\n--- /dev/null\n+++ b/added.txt\n"
    );
    expect(normalized).not.toContain("2026-09-30");
    // A space-separated timestamp, a `diff -ru` command line, and body lines
    // that look like headers but are not followed by a hunk.
    const recursive = [
      "diff -ru a/x.txt b/x.txt",
      "--- x.txt 2026-09-30 10:00:00.000000000 +0200",
      "+++ x.txt 2026-09-30 11:00:00.000000000 +0200",
      "@@ -1,2 +1,2 @@",
      "--- old",
      "+++ new",
      " kept",
      "",
    ].join("\n");
    expect(normalizePatch(recursive, undefined)).toBe(
      [
        "diff --git a/x.txt b/x.txt",
        "--- a/x.txt",
        "+++ b/x.txt",
        "@@ -1,2 +1,2 @@",
        "--- old",
        "+++ new",
        " kept",
        "",
      ].join("\n")
    );
  });

  it("reads a bare patch and a lone hunk", async () => {
    const bare = '--- a/app.json\n+++ b/app.json\n@@ -1,2 +1,2 @@\n {\n-  "a": 1\n+  "a": 2\n';
    expect(normalizePatch(bare, undefined)).toMatch(/^diff --git a\/app\.json b\/app\.json\n/);
    expect(normalizePatch("@@ -1 +1 @@\n-a\n+b\n", "x.txt")).toMatch(
      /^diff --git a\/x\.txt b\/x\.txt\n--- a\/x\.txt\n\+\+\+ b\/x\.txt\n@@/
    );
    const git = "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n-a\n+b\n";
    expect(normalizePatch(git, "ignored")).toBe(git);
    render(
      withTooltips(
        createElement(kit.DiffView, { patch: bare, view: "split", "data-testid": "diff" })
      )
    );
    const root = await loadedDiff("diff");
    await hunkHeaders(root);
    expect(root.dataset.view).toBe("split");
    expect(root.textContent).toContain("app.json");
  });

  it("says there is nothing to show for identical texts", async () => {
    render(withTooltips(createElement(kit.DiffView, { oldText: "a\n", newText: "a\n" })));
    await screen.findByText("No changes detected");
  });

  it("ignores values off the contract", async () => {
    render(
      withTooltips(
        untyped("DiffView", {
          oldText: SAVED,
          newText: EDITED,
          view: "sideways",
          context: -2,
          maxHeight: "big",
          hunkActions: "revert",
          "data-testid": "diff",
        })
      )
    );
    const root = await loadedDiff("diff");
    const headers = await hunkHeaders(root);
    expect(root.dataset.view).toBe("unified");
    // The default three lines of context join both changes into one hunk.
    expect(headers).toHaveLength(1);
    expect(root.style.maxHeight).toBe("");
    expect(root.querySelector("[data-kit-hunk-action]")).toBeNull();
  });
});

describe("revertHunk", () => {
  const hunk = (patch: Partial<DiffHunk>): DiffHunk => ({
    index: 0,
    filePath: "",
    header: "",
    oldStart: 1,
    oldCount: 1,
    newStart: 1,
    newCount: 1,
    oldText: "",
    newText: "",
    patch: "",
    ...patch,
  });

  it("undoes an insertion, a deletion and a replacement", () => {
    expect(
      kit.revertHunk("a\nnew\nb", hunk({ newStart: 2, newCount: 1, oldCount: 0, newText: "new" }))
    ).toBe("a\nb");
    expect(
      kit.revertHunk("a\nb", hunk({ newStart: 1, newCount: 0, oldCount: 1, oldText: "gone" }))
    ).toBe("a\ngone\nb");
    expect(
      kit.revertHunk(
        "x\ny\nz",
        hunk({ newStart: 2, newCount: 1, oldCount: 2, oldText: "y1\ny2", newText: "y" })
      )
    ).toBe("x\ny1\ny2\nz");
  });

  it("refuses a hunk the text no longer matches, or a malformed one", () => {
    expect(kit.revertHunk("a\nb", hunk({ newStart: 2, newText: "changed" }))).toBeNull();
    expect(kit.revertHunk("a", hunk({ newStart: 5, newText: "a" }))).toBeNull();
    expect(kit.revertHunk("a", hunk({ newStart: 1.5 }))).toBeNull();
    expect(Reflect.apply(kit.revertHunk, undefined, ["a", null])).toBeNull();
    expect(kit.revertHunk("a", hunk({ newText: "a", oldCount: -1 }))).toBeNull();
    // Counts that disagree with the hunk's own lines.
    expect(kit.revertHunk("a", hunk({ newText: "a", oldCount: 3, oldText: "x" }))).toBeNull();
  });

  it("puts back a very large hunk without overflowing the call stack", () => {
    const old = Array.from({ length: 200_000 }, (_, i) => `line ${i}`).join("\n");
    const result = kit.revertHunk(
      "only",
      hunk({ newText: "only", oldCount: 200_000, oldText: old })
    );
    expect(result).toBe(old);
  });
});

describe("formatMarkdown", () => {
  const run = (
    text: string,
    start: number,
    end: number,
    kind: Parameters<typeof formatMarkdown>[3]
  ) => {
    const edit = formatMarkdown(text, start, end, kind);
    const next = applyMarkdownEdit(text, edit);
    return { next, selected: next.slice(edit.selectionStart, edit.selectionEnd), edit };
  };

  it("wraps a selection and unwraps it again", () => {
    const wrapped = run("make it bold", 8, 12, "bold");
    expect(wrapped.next).toBe("make it **bold**");
    expect(wrapped.selected).toBe("bold");
    const back = run(wrapped.next, wrapped.edit.selectionStart, wrapped.edit.selectionEnd, "bold");
    expect(back.next).toBe("make it bold");
    expect(run("_x_", 0, 3, "italic").next).toBe("x");
    // Two bold runs selected together are wrapped, not unpaired.
    expect(run("**one** and **two**", 0, 19, "bold").next).not.toBe("one** and **two");
  });

  it("puts the caret between empty marks", () => {
    const { next, edit } = run("", 0, 0, "italic");
    expect(next).toBe("__");
    expect([edit.selectionStart, edit.selectionEnd]).toEqual([1, 1]);
  });

  it("fences a multi-line selection and ticks a single line", () => {
    expect(run("a\nb", 0, 3, "code").next).toBe("```\na\nb\n```");
    expect(run("say x\ny", 4, 7, "code").next).toBe("say \n```\nx\ny\n```");
    expect(run("call fn()", 5, 9, "code").next).toBe("call `fn()`");
    // The closing fence keeps its own line when text follows.
    expect(run("a\nb\nc", 0, 4, "code").next).toBe("```\na\nb\n```\nc");
  });

  it("links text with the address selected, or an address with the caret in its text", () => {
    const text = run("docs", 0, 4, "link");
    expect(text.next).toBe("[docs](url)");
    expect(text.selected).toBe("url");
    const address = run("https://daintree.dev", 0, 20, "link");
    expect(address.next).toBe("[](https://daintree.dev)");
    expect(address.edit.selectionStart).toBe(1);
    // With nothing selected, what is typed next is the link's text.
    const empty = run("see ", 4, 4, "link");
    expect(empty.next).toBe("see [](url)");
    expect([empty.edit.selectionStart, empty.edit.selectionEnd]).toEqual([5, 5]);
  });

  it("keeps a selection inside one line on the same text when listing it", () => {
    const listed = run("fix the bug", 4, 7, "bullets");
    expect(listed.next).toBe("- fix the bug");
    expect(listed.selected).toBe("the");
    const unlisted = run("- fix the bug", 6, 9, "bullets");
    expect(unlisted.next).toBe("fix the bug");
    expect(unlisted.selected).toBe("the");
  });

  it("toggles list markers over every selected line, swapping one kind for the other", () => {
    expect(run("one\ntwo", 0, 7, "bullets").next).toBe("- one\n- two");
    expect(run("- one\n- two", 0, 11, "bullets").next).toBe("one\ntwo");
    expect(run("- one\n- two", 2, 8, "numbers").next).toBe("1. one\n2. two");
    // A marker of either kind is replaced, never stacked.
    expect(run("- one\ntwo", 0, 9, "bullets").next).toBe("- one\n- two");
    expect(run("1. one\ntwo", 0, 10, "numbers").next).toBe("1. one\n2. two");
    // A caret at the very start lists the first line only.
    expect(run("\none", 0, 0, "bullets").next).toBe("- \none");
    // A caret inside a line lists that line.
    expect(run("a\nmiddle\nc", 4, 4, "bullets").next).toBe("a\n- middle\nc");
  });
});

describe("MarkdownEditor", () => {
  function textarea(root: HTMLElement): HTMLTextAreaElement {
    const found = root.querySelector<HTMLTextAreaElement>("textarea");
    if (!found) throw new Error("no textarea");
    return found;
  }

  it("writes in a text area and previews through the kit's Markdown", async () => {
    const onModeChange = vi.fn();
    render(
      withTooltips(
        createElement(kit.MarkdownEditor, {
          defaultValue: "**Ship it**",
          "aria-label": "Release notes",
          onModeChange,
          "data-testid": "md",
        })
      )
    );
    const root = screen.getByTestId("md");
    expect(textarea(root).getAttribute("aria-label")).toBe("Release notes");
    const write = screen.getByRole("tab", { name: "Write" });
    expect(write.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("toolbar", { name: "Formatting" })).toBeDefined();
    fireEvent.click(screen.getByRole("tab", { name: "Preview" }));
    expect(onModeChange).toHaveBeenCalledWith("preview");
    // Kept behind Preview, so its undo history survives the visit.
    expect(textarea(root).closest("[hidden]")).not.toBeNull();
    // Both panels stay mounted, so each tab's aria-controls resolves.
    for (const tab of screen.getAllByRole("tab")) {
      expect(document.getElementById(tab.getAttribute("aria-controls") ?? "")).not.toBeNull();
    }
    expect(screen.queryByRole("toolbar", { name: "Formatting" })).toBeNull();
    const strong = await waitFor(() => {
      const found = root.querySelector("strong");
      if (!found) throw new Error("preview not rendered");
      return found;
    });
    expect(strong.textContent).toBe("Ship it");
    expect(screen.getByRole("tabpanel").id).toBe(
      screen.getByRole("tab", { name: "Preview" }).getAttribute("aria-controls")
    );
  });

  it("says when there is nothing to preview", () => {
    render(withTooltips(createElement(kit.MarkdownEditor, { defaultMode: "preview" })));
    expect(screen.getByText("Nothing to preview")).toBeDefined();
  });

  it("submits on Cmd+Enter and cancels on Escape", () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    render(
      withTooltips(
        createElement(kit.MarkdownEditor, {
          value: "LGTM",
          onSubmit,
          onCancel,
          "data-testid": "md",
        })
      )
    );
    const field = textarea(screen.getByTestId("md"));
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.keyDown(field, { key: "Enter", metaKey: true });
    fireEvent.keyDown(field, { key: "Enter", ctrlKey: true });
    expect(onSubmit).toHaveBeenCalledWith("LGTM");
    fireEvent.keyDown(field, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("formats the selection from the toolbar as one change", () => {
    const onChange = vi.fn();
    render(
      withTooltips(
        createElement(kit.MarkdownEditor, {
          defaultValue: "fix bug",
          onChange,
          "data-testid": "md",
        })
      )
    );
    const field = textarea(screen.getByTestId("md"));
    field.setSelectionRange(4, 7);
    fireEvent.click(screen.getByRole("button", { name: "Italic" }));
    expect(onChange).toHaveBeenLastCalledWith("fix _bug_");
    expect(field.value).toBe("fix _bug_");
    expect(field.value.slice(field.selectionStart, field.selectionEnd)).toBe("bug");
  });

  it("formats from the keyboard with a combo the app is not bound to", () => {
    const onChange = vi.fn();
    render(
      withTooltips(
        createElement(kit.MarkdownEditor, { defaultValue: "x", onChange, "data-testid": "md" })
      )
    );
    const field = textarea(screen.getByTestId("md"));
    field.setSelectionRange(0, 1);
    // Cmd+E, GitHub's code combo, opens Canopy: it stays the app's.
    fireEvent.keyDown(field, { key: "e", metaKey: true });
    fireEvent.keyDown(field, { key: "e", ctrlKey: true });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.keyDown(field, { key: "i", metaKey: true });
    fireEvent.keyDown(field, { key: "i", ctrlKey: true });
    expect(onChange).toHaveBeenCalledWith("_x_");
  });

  it("shows source and preview side by side in the split layout", () => {
    render(
      withTooltips(
        createElement(kit.MarkdownEditor, {
          defaultValue: "# Hi",
          layout: "split",
          "data-testid": "md",
        })
      )
    );
    const root = screen.getByTestId("md");
    expect(root.dataset.mode).toBe("split");
    expect(root.querySelector("textarea")).not.toBeNull();
    expect(screen.getByRole("region", { name: "Preview" })).toBeDefined();
    expect(screen.queryByRole("tab")).toBeNull();
  });

  it("follows a controlled mode and drops the toolbar when read-only", () => {
    const { rerender } = render(
      withTooltips(createElement(kit.MarkdownEditor, { value: "a", mode: "write", readOnly: true }))
    );
    expect(screen.queryByRole("toolbar")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Preview" }));
    // Controlled: nothing moves until the view says so.
    expect(screen.getByRole("tab", { name: "Write" }).getAttribute("aria-selected")).toBe("true");
    rerender(withTooltips(createElement(kit.MarkdownEditor, { value: "a", mode: "preview" })));
    expect(screen.getByRole("tab", { name: "Preview" }).getAttribute("aria-selected")).toBe("true");
  });

  it("draws the footer under the field and ignores values off the contract", () => {
    render(
      withTooltips(
        untyped("MarkdownEditor", {
          value: 7,
          mode: "edit",
          layout: "columns",
          minRows: -1,
          footer: createElement("button", { type: "button" }, "Comment"),
          "data-testid": "md",
        })
      )
    );
    const root = screen.getByTestId("md");
    expect(textarea(root).value).toBe("");
    expect(textarea(root).rows).toBe(3);
    expect(root.dataset.mode).toBe("write");
    expect(screen.getByRole("button", { name: "Comment" })).toBeDefined();
  });
});
