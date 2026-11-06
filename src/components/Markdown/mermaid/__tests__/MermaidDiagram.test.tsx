// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import type { MermaidRenderResult } from "../mermaidRenderer";

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn(() => Promise.resolve()) },
}));
vi.mock("@/hooks/useScopedSelectAll", () => ({ useScopedSelectAll: () => {} }));

interface PendingRender {
  source: string;
  themeSignature: string;
  resolve: (result: MermaidRenderResult) => void;
}

const renderer = vi.hoisted(() => ({
  pending: [] as PendingRender[],
  cached: new Map<string, MermaidRenderResult>(),
  cancelled: [] as string[],
  instances: 0,
}));

vi.mock("../mermaidRenderer", () => ({
  MERMAID_MAX_SOURCE_CHARS: 50_000,
  mermaidRefusal: (source: string) => (source.includes("https://") ? "url" : null),
  peekMermaidRender: (source: string) => renderer.cached.get(source),
  requestMermaidRender: (source: string, themeSignature: string) => ({
    result: new Promise<MermaidRenderResult>((resolve) => {
      renderer.pending.push({ source, themeSignature, resolve });
    }),
    cancel: () => {
      renderer.cancelled.push(source);
    },
  }),
  instantiateMermaidSvg: (result: { svg: string; templateId: string }, instanceId: string) =>
    result.svg.split(result.templateId).join(instanceId),
  nextMermaidInstanceId: () => `mount-${++renderer.instances}`,
}));

import { MarkdownDocument } from "../../MarkdownDocument";
import { RenderedMarkdownDiff } from "@/components/Worktree/RenderedMarkdownDiff";

const DIAGRAM = "graph TD\n  A --> B";
const DOC = ["# Plan", "", "```mermaid", DIAGRAM, "```", "", "```ts", "const x = 1;", "```"].join(
  "\n"
);
const SVG = '<svg id="tpl" xmlns="http://www.w3.org/2000/svg"><text>A to B</text></svg>';
const RENDERED: MermaidRenderResult = { ok: true, svg: SVG, templateId: "tpl" };

function renderDoc(content = DOC) {
  return render(<MarkdownDocument filePath="/repo/plan.md" rootPath="/repo" content={content} />);
}

async function settle(result: MermaidRenderResult) {
  await act(async () => {
    for (const request of renderer.pending.splice(0)) request.resolve(result);
  });
}

beforeEach(() => {
  renderer.pending.length = 0;
  renderer.cached.clear();
  renderer.cancelled.length = 0;
});

afterEach(() => {
  document.documentElement.removeAttribute("style");
});

describe("mermaid fences in rendered Markdown", () => {
  it("shows the fence source while the diagram renders, then swaps in the svg", async () => {
    const { container } = renderDoc();
    const block = container.querySelector(".markdown-mermaid");
    expect(block?.getAttribute("data-mermaid-state")).toBe("pending");
    expect(block?.querySelector("pre")?.textContent).toBe(DIAGRAM);
    expect(renderer.pending.map((request) => request.source)).toEqual([DIAGRAM]);

    await settle(RENDERED);

    expect(block?.getAttribute("data-mermaid-state")).toBe("rendered");
    expect(block?.querySelector("svg text")?.textContent).toBe("A to B");
    expect(block?.querySelector("pre")).toBeNull();
    // The diagram replaces the fence rather than nesting inside a <pre>.
    expect(block?.closest("pre")).toBeNull();
  });

  it("keeps the source on screen when the diagram fails to parse", async () => {
    const { container } = renderDoc();
    await settle({ ok: false });

    const block = container.querySelector(".markdown-mermaid");
    expect(block?.getAttribute("data-mermaid-state")).toBe("failed");
    expect(block?.querySelector("pre code")?.textContent).toBe(DIAGRAM);
    // The failure note carries a status glyph svg, so look for the diagram itself.
    expect(block?.querySelector(".markdown-mermaid__diagram")).toBeNull();
    expect(block?.querySelector("svg text")).toBeNull();
  });

  it("leaves other fences as highlighted code", () => {
    const { container } = renderDoc();
    expect(container.querySelectorAll(".markdown-mermaid")).toHaveLength(1);
    expect(container.querySelector("pre code.language-typescript")?.textContent).toBe(
      "const x = 1;"
    );
  });

  it("paints a cached diagram on mount without waiting for a render", () => {
    renderer.cached.set(DIAGRAM, RENDERED);
    const { container } = renderDoc();
    const block = container.querySelector(".markdown-mermaid");
    expect(block?.getAttribute("data-mermaid-state")).toBe("rendered");
    expect(block?.querySelector("svg")).not.toBeNull();
  });

  it("re-renders against the new theme and keeps the old diagram up meanwhile", async () => {
    const { container } = renderDoc();
    await settle(RENDERED);
    expect(renderer.pending).toHaveLength(0);

    await act(async () => {
      document.documentElement.style.setProperty("--color-surface-canvas", "#fafafa");
      await Promise.resolve();
    });

    expect(renderer.pending).toHaveLength(1);
    const block = container.querySelector(".markdown-mermaid");
    expect(block?.getAttribute("data-mermaid-state")).toBe("rendered");

    await settle({
      ok: true,
      svg: '<svg id="tpl" xmlns="http://www.w3.org/2000/svg"><text>light</text></svg>',
      templateId: "tpl",
    });
    expect(block?.querySelector("svg text")?.textContent).toBe("light");
  });

  it("does not load anything for a document without a mermaid fence", () => {
    renderDoc("# Plain\n\n```ts\nconst y = 2;\n```");
    expect(renderer.pending).toHaveLength(0);
  });

  it("gives each mount of the same diagram its own ids", async () => {
    const { container } = renderDoc(
      ["```mermaid", DIAGRAM, "```", "", "```mermaid", DIAGRAM, "```"].join("\n")
    );
    await settle(RENDERED);
    const ids = Array.from(container.querySelectorAll(".markdown-mermaid svg")).map(
      (svg) => svg.id
    );
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it("drops a stale diagram when the source changes and shows the new source meanwhile", async () => {
    const view = renderDoc();
    await settle(RENDERED);
    const edited = DOC.replace("A --> B", "A --> C");
    view.rerender(<MarkdownDocument filePath="/repo/plan.md" rootPath="/repo" content={edited} />);

    const block = view.container.querySelector(".markdown-mermaid");
    expect(block?.getAttribute("data-mermaid-state")).toBe("pending");
    expect(block?.querySelector("pre")?.textContent).toBe("graph TD\n  A --> C");
    expect(renderer.cancelled).toContain(DIAGRAM);
  });

  it("says the renderer couldn't load instead of waiting for good, and retries on request", async () => {
    const { container } = renderDoc();
    await settle({ ok: false, transient: true });
    const block = container.querySelector(".markdown-mermaid");
    expect(block?.getAttribute("data-mermaid-state")).toBe("failed");
    expect(block?.querySelector("pre code")?.textContent).toBe(DIAGRAM);
    const retry = Array.from(block?.querySelectorAll("button") ?? []).find(
      (button) => button.textContent === "Retry"
    );
    expect(retry).toBeDefined();
    act(() => retry!.click());
    expect(document.activeElement).toBe(block);
    expect(block?.getAttribute("data-mermaid-state")).toBe("pending");
    expect(renderer.pending.map((request) => request.source)).toEqual([DIAGRAM]);
    await settle(RENDERED);
    expect(block?.getAttribute("data-mermaid-state")).toBe("rendered");
  });

  it("names why a refused diagram shows as source, apart from a syntax error", async () => {
    const refused = 'graph TD\n  click A "https://example.com"';
    const { container } = renderDoc(
      ["```mermaid", DIAGRAM, "```", "", "```mermaid", refused, "```"].join("\n")
    );
    await settle({ ok: false });
    const notes = Array.from(container.querySelectorAll(".markdown-mermaid__note")).map(
      (note) => note.textContent
    );
    expect(notes).toHaveLength(2);
    expect(notes[0]).not.toBe(notes[1]);
    expect(container.querySelectorAll('[role="status"] svg')).toHaveLength(2);
  });

  it("releases its render request on unmount", () => {
    const view = renderDoc();
    view.unmount();
    expect(renderer.cancelled).toEqual([DIAGRAM]);
  });

  it("renders a fence tagged with a capitalised language name", () => {
    const { container } = renderDoc(["```Mermaid", DIAGRAM, "```"].join("\n"));
    expect(container.querySelector(".markdown-mermaid")).not.toBeNull();
  });

  it("renders both halves of a changed diagram in the rendered diff", async () => {
    const oldSource = "graph TD\n  A --> B";
    const newSource = "graph TD\n  A --> C";
    const diff = [
      "diff --git a/docs/plan.md b/docs/plan.md",
      "--- a/docs/plan.md",
      "+++ b/docs/plan.md",
      "@@ -1,6 +1,6 @@",
      " # Plan",
      " ",
      " ```mermaid",
      " graph TD",
      "-  A --> B",
      "+  A --> C",
      " ```",
    ].join("\n");

    const { container } = render(
      <RenderedMarkdownDiff
        diff={diff}
        newSource={["# Plan", "", "```mermaid", newSource, "```", ""].join("\n")}
        status="modified"
        filePath="/repo/docs/plan.md"
        rootPath="/repo"
        attemptKey="attempt-1"
        requestKey="pane-1"
      />
    );

    expect(renderer.pending.map((request) => request.source).sort()).toEqual(
      [newSource, oldSource].sort()
    );
    const removed = container.querySelector(
      ".rendered-markdown-diff__block--removed .markdown-mermaid"
    );
    const added = container.querySelector(
      ".rendered-markdown-diff__block--added .markdown-mermaid"
    );
    expect(removed?.querySelector("pre")?.textContent).toBe(oldSource);
    expect(added?.querySelector("pre")?.textContent).toBe(newSource);

    await settle(RENDERED);
    expect(removed?.querySelector("svg")).not.toBeNull();
    expect(added?.querySelector("svg")).not.toBeNull();
  });
});
