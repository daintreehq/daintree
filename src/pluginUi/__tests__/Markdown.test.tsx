// @vitest-environment jsdom
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

const dispatchMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: dispatchMock },
}));

// Through the public specifier, the way a plugin view reaches it.
import { Markdown } from "@daintreehq/plugin-ui";
import { resolvePluginMarkdownPaths } from "@/components/Markdown/PluginMarkdown";
import { buildDaintreeFileUrl } from "@/components/FileViewer/filePreviewKinds";

beforeEach(() => {
  dispatchMock.mockClear();
  Reflect.deleteProperty(window, "__pluginUiPwned");
});

async function renderMarkdown(props: Parameters<typeof Markdown>[0]) {
  // Written the way a zero-build view writes it.
  const result = render(createElement(Markdown, props));
  // The renderer is lazy; its root appearing means the chunk resolved.
  await vi.waitFor(() => {
    if (!result.container.querySelector(".markdown-document")) throw new Error("not rendered");
  });
  return result;
}

describe("@daintreehq/plugin-ui Markdown", () => {
  it("paints nothing while its renderer loads, then the document", async () => {
    // A fresh module graph, so this `lazy()` has never resolved: the first
    // commit is the Suspense fallback, whatever ran before this test.
    vi.resetModules();
    const fresh = await import("@daintreehq/plugin-ui");
    const { container } = render(createElement(fresh.Markdown, { source: "# Loaded" }));

    expect(container.innerHTML).toBe("");
    await vi.waitFor(() => {
      if (!container.querySelector("h1")) throw new Error("not rendered");
    });
    expect(container.querySelector("h1")?.textContent).toBe("Loaded");
  });

  it("renders headings, lists and GFM tables with the host's document styling", async () => {
    const { container } = await renderMarkdown({
      source: [
        "# Pipeline",
        "",
        "- first",
        "- second",
        "",
        "| Stage | Owner |",
        "| ----- | ----- |",
        "| Lead  | Ana   |",
      ].join("\n"),
      basePath: "/repo/notes/pipeline.md",
    });

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Pipeline");
    expect(container.querySelectorAll("ul > li")).toHaveLength(2);
    expect(container.querySelector("table td")?.textContent).toBe("Lead");
    const root = container.querySelector(".markdown-document");
    expect(root?.classList.contains("prose")).toBe(true);
  });

  it("drops raw HTML instead of rendering it", async () => {
    const { container } = await renderMarkdown({
      source: [
        "Before",
        "",
        "<script>window.__pluginUiPwned = true</script>",
        "",
        '<img src="x.png" onerror="window.__pluginUiPwned = true">',
        "",
        'Inline <span onclick="window.__pluginUiPwned = true">span</span> after',
      ].join("\n"),
      basePath: "/repo/notes/",
    });

    expect(container.textContent).toContain("Before");
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("[onerror], [onclick]")).toBeNull();
    expect(Reflect.get(window, "__pluginUiPwned")).toBeUndefined();
  });

  it("loads a relative image through daintree-file:// contained to rootPath", async () => {
    const { container } = await renderMarkdown({
      source: "![diagram](images/flow.png)",
      basePath: "/repo/.daintree/plugins/acme.crm/notes",
      rootPath: "/repo/.daintree/plugins/acme.crm",
    });

    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      buildDaintreeFileUrl(
        "/repo/.daintree/plugins/acme.crm/notes/images/flow.png",
        "/repo/.daintree/plugins/acme.crm"
      )
    );
  });

  it("keeps images and links that climb out of rootPath unresolved", async () => {
    const { container } = await renderMarkdown({
      source: "![secret](../secret.png)\n\n[up](../secret.md) and [deep](../../../etc/passwd)",
      basePath: "/repo/notes/today.md",
      rootPath: "/repo/notes",
    });

    expect(container.querySelector("img")?.hasAttribute("src")).toBe(false);
    fireEvent.click(screen.getByText("up"));
    fireEvent.click(screen.getByText("deep"));
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("resolves a relative image against rootPath when there is no basePath", async () => {
    const { container } = await renderMarkdown({
      source: "![logo](img/logo.png)",
      rootPath: "/repo/assets",
    });

    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      buildDaintreeFileUrl("/repo/assets/img/logo.png", "/repo/assets")
    );
  });

  it("renders without a basePath, leaving relative references unresolved", async () => {
    const { container } = await renderMarkdown({
      source:
        "Text with ![local](pic.png) and [a note](other.md).\n\n![remote](https://example.com/a.png)",
    });

    expect(container.textContent).toContain("Text with");
    const images = container.querySelectorAll("img");
    expect(images[0]?.hasAttribute("src")).toBe(false);
    expect(images[1]?.getAttribute("src")).toBe("https://example.com/a.png");

    fireEvent.click(screen.getByText("a note"));
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("opens a relative link inside rootPath in the file viewer", async () => {
    await renderMarkdown({
      source: "[spec](../docs/spec.md)",
      basePath: "/repo/notes/today.md",
      rootPath: "/repo",
    });

    fireEvent.click(screen.getByText("spec"));
    expect(dispatchMock).toHaveBeenCalledWith(
      "file.view",
      { path: "/repo/docs/spec.md", rootPath: "/repo", confineToRoot: true },
      { source: "user" }
    );
  });

  it("tolerates the loose props a hand-written view can pass", async () => {
    // Parsed rather than typed: this is the untyped shape plain JavaScript sends.
    const { container } = await renderMarkdown(JSON.parse('{"fontSize":"huge","className":7}'));
    const root = container.querySelector<HTMLElement>(".markdown-document");
    expect(root?.textContent).toBe("");
    expect(root?.style.getPropertyValue("--markdown-font-size")).toBe("");
  });

  it("applies a reading size from the shared type scale", async () => {
    const { container } = await renderMarkdown({ source: "Hello", fontSize: "lg" });
    const root = container.querySelector<HTMLElement>(".markdown-document");
    expect(root?.style.getPropertyValue("--markdown-font-size")).toBe("var(--text-lg)");
  });
});

describe("@daintreehq/plugin-ui Markdown select all", () => {
  it("selects the block the user clicked into, not every block in the pane", async () => {
    const { container } = render(
      createElement(
        "div",
        { "data-panel-id": "plugin-pane", tabIndex: -1 },
        createElement(Markdown, { source: "first block" }),
        createElement(Markdown, { source: "second block" })
      )
    );
    await vi.waitFor(() => {
      if (container.querySelectorAll(".markdown-document").length !== 2) throw new Error("wait");
    });
    const [, second] = container.querySelectorAll<HTMLElement>(".markdown-document");
    const range = document.createRange();
    range.setStart(second!.querySelector("p")!.firstChild!, 3);
    range.collapse(true);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);

    const pane = container.querySelector("[data-panel-id]")!;
    pane.dispatchEvent(
      new KeyboardEvent("keydown", { key: "a", metaKey: true, bubbles: true, cancelable: true })
    );

    expect(window.getSelection()?.toString()).toBe("second block");
    window.getSelection()?.removeAllRanges();
  });
});

describe("resolvePluginMarkdownPaths", () => {
  it("reads a Markdown file path as the document and bounds to its directory", () => {
    expect(resolvePluginMarkdownPaths("/repo/notes/today.md", undefined)).toEqual({
      filePath: "/repo/notes/index.md",
      rootPath: "/repo/notes",
    });
  });

  it("reads anything else as a directory, dotted plugin directories included", () => {
    expect(resolvePluginMarkdownPaths("/repo/.daintree/plugins/acme.crm", undefined)).toEqual({
      filePath: "/repo/.daintree/plugins/acme.crm/index.md",
      rootPath: "/repo/.daintree/plugins/acme.crm",
    });
    expect(resolvePluginMarkdownPaths("/repo/drafts.md/", undefined).rootPath).toBe(
      "/repo/drafts.md"
    );
  });

  it("keeps an explicit rootPath and falls back to it without a basePath", () => {
    expect(resolvePluginMarkdownPaths("/repo/notes/a.md", "/repo")).toEqual({
      filePath: "/repo/notes/index.md",
      rootPath: "/repo",
    });
    expect(resolvePluginMarkdownPaths(undefined, "/repo")).toEqual({
      filePath: "/repo/index.md",
      rootPath: "/repo",
    });
  });

  it("ignores relative or non-string paths", () => {
    expect(resolvePluginMarkdownPaths("notes/a.md", 42)).toEqual({ filePath: "", rootPath: "" });
    expect(resolvePluginMarkdownPaths(undefined, undefined)).toEqual({
      filePath: "",
      rootPath: "",
    });
  });
});
