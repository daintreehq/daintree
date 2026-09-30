// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MermaidConfig } from "mermaid";

const mermaidMock = vi.hoisted(() => ({
  initialize: vi.fn<(config: MermaidConfig) => void>(),
  parse: vi.fn<(text: string, options?: { suppressErrors?: boolean }) => Promise<unknown>>(),
  render: vi.fn<(id: string, text: string) => Promise<{ svg: string }>>(),
}));

vi.mock("mermaid", () => ({ default: mermaidMock }));

const theme = vi.hoisted(() => ({ signature: "theme-a" }));

vi.mock("../mermaidTheme", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../mermaidTheme")>();
  return {
    ...actual,
    readThemeSignature: () => theme.signature,
    // jsdom has no canvas; the palette's shape is what matters here.
    resolveMermaidPalette: () => ({
      darkMode: true,
      fontFamily: "Test Sans",
      colors: { background: "#010101", text: "#070707", border: "#050505" },
    }),
  };
});

import {
  _resetMermaidRendererForTests,
  instantiateMermaidSvg,
  MERMAID_MAX_SOURCE_CHARS,
  peekMermaidRender,
  requestMermaidRender,
  type MermaidRenderResult,
} from "../mermaidRenderer";

const SLOW_RENDER_MS = 1;

function svgFor(id: string, label: string): string {
  return (
    `<svg id="${id}" xmlns="http://www.w3.org/2000/svg">` +
    `<style>#${id} .label{fill:#123;}</style>` +
    `<defs><marker id="${id}_arrow"><path d="M0,0 L1,1"/></marker></defs>` +
    `<path d="M0,0 L1,1" marker-end="url(#${id}_arrow)"/><text>${label}</text></svg>`
  );
}

function render(source: string, signature = theme.signature): Promise<MermaidRenderResult> {
  return requestMermaidRender(source, signature).result;
}

beforeEach(() => {
  _resetMermaidRendererForTests();
  theme.signature = "theme-a";
  mermaidMock.initialize.mockReset();
  mermaidMock.parse.mockReset().mockResolvedValue({ diagramType: "flowchart-v2" });
  mermaidMock.render
    .mockReset()
    .mockImplementation(async (id, text) => ({ svg: svgFor(id, text) }));
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("requestMermaidRender", () => {
  it("returns sanitized svg for a diagram that parses", async () => {
    mermaidMock.render.mockImplementation(async (id) => ({
      svg: `<svg id="${id}" xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><g onclick="x()"><text>A</text></g></svg>`,
    }));

    const result = await render("graph TD; A-->B");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.svg).toContain("<text>A</text>");
    expect(result.svg).not.toContain("<script");
    expect(result.svg).not.toContain("onclick");
  });

  it("initializes strict, text-only labels, and locks every host-owned key against directives", async () => {
    await render("graph TD; A-->B");

    expect(mermaidMock.initialize).toHaveBeenCalledTimes(1);
    const config = mermaidMock.initialize.mock.calls[0]![0];
    expect(config.securityLevel).toBe("strict");
    expect(config.htmlLabels).toBe(false);
    expect(config.startOnLoad).toBe(false);
    expect(config.theme).toBe("base");
    expect(config.darkMode).toBe(true);
    expect(config.themeVariables.primaryTextColor).toBe("#070707");
    // Tokens that did not resolve leave Mermaid's own derivation in place.
    expect("secondaryColor" in config.themeVariables).toBe(false);
    for (const key of [
      "securityLevel",
      "htmlLabels",
      "dompurifyConfig",
      "theme",
      "themeVariables",
      "themeCSS",
      "maxTextSize",
      "deterministicIds",
      "secure",
    ]) {
      expect(config.secure).toContain(key);
    }
  });

  it("re-initializes only when the theme signature changes", async () => {
    await render("graph TD; A-->B");
    await render("graph TD; B-->C");
    expect(mermaidMock.initialize).toHaveBeenCalledTimes(1);

    theme.signature = "theme-b";
    await render("graph TD; A-->B");
    expect(mermaidMock.initialize).toHaveBeenCalledTimes(2);
  });

  it("skips a job whose theme moved while it was queued, without caching it", async () => {
    const request = requestMermaidRender("graph TD; A-->B", "theme-a");
    theme.signature = "theme-b";

    expect(await request.result).toEqual({ ok: false, transient: true });
    expect(mermaidMock.render).not.toHaveBeenCalled();
    expect(peekMermaidRender("graph TD; A-->B", "theme-a")).toBeUndefined();
  });

  it("skips a job every requester cancelled", async () => {
    const request = requestMermaidRender("graph TD; A-->B", "theme-a");
    request.cancel();

    expect(await request.result).toEqual({ ok: false, transient: true });
    expect(mermaidMock.render).not.toHaveBeenCalled();
  });

  it("still runs a shared job when only one of its requesters cancelled", async () => {
    const first = requestMermaidRender("graph TD; A-->B", "theme-a");
    const second = requestMermaidRender("graph TD; A-->B", "theme-a");
    first.cancel();

    expect((await second.result).ok).toBe(true);
    expect(mermaidMock.render).toHaveBeenCalledTimes(1);
  });

  it("falls back when the source does not parse, and caches that verdict", async () => {
    mermaidMock.parse.mockRejectedValue(new Error("Parse error on line 1"));

    const result = await render("not a diagram");

    expect(result).toEqual({ ok: false });
    expect(mermaidMock.render).not.toHaveBeenCalled();
    expect(peekMermaidRender("not a diagram", "theme-a")).toEqual({ ok: false });
  });

  it("does not cache a diagram chunk that failed to load, so a later attempt can succeed", async () => {
    mermaidMock.parse.mockRejectedValueOnce(
      new TypeError("Failed to fetch dynamically imported module: flowDiagram-abc.js")
    );

    expect(await render("graph TD; A-->B")).toEqual({ ok: false, transient: true });
    expect(peekMermaidRender("graph TD; A-->B", "theme-a")).toBeUndefined();
    expect((await render("graph TD; A-->B")).ok).toBe(true);
  });

  it.each([
    ["an image shape", 'flowchart TD\n  A@{ img: "https://tracker.example/p.png" }'],
    ["a classDef url()", "flowchart TD\n  classDef x fill:url(https://tracker.example/p.png)"],
    ["a style image-set()", "flowchart TD\n  style A background:image-set('x.png' 1x)"],
    ["an escaped style value", "flowchart TD\n  classDef x fill:u\\72l(https://t.example)"],
  ])(
    "never hands mermaid a source with %s, since it would fetch before sanitizing",
    async (_, source) => {
      expect(await render(source)).toEqual({ ok: false });
      expect(mermaidMock.parse).not.toHaveBeenCalled();
    }
  );

  it("falls back and removes mermaid's scratch nodes when render throws", async () => {
    mermaidMock.render.mockImplementation(async (id) => {
      const scratch = document.createElement("div");
      scratch.id = `d${id}`;
      document.body.appendChild(scratch);
      throw new Error("layout failed");
    });

    const result = await render("graph TD; A-->B");

    expect(result).toEqual({ ok: false });
    expect(document.body.children).toHaveLength(0);
  });

  it("falls back when sanitizing leaves no svg", async () => {
    mermaidMock.render.mockResolvedValue({ svg: "<div>not svg</div>" });
    expect(await render("graph TD; A-->B")).toEqual({ ok: false });
  });

  it("never loads mermaid for a source over the size cap", async () => {
    const result = await render("x".repeat(MERMAID_MAX_SOURCE_CHARS + 1));
    expect(result).toEqual({ ok: false });
    expect(mermaidMock.parse).not.toHaveBeenCalled();
  });

  it("caches by source and theme, and exposes the cache synchronously", async () => {
    expect(peekMermaidRender("graph TD; A-->B", "theme-a")).toBeUndefined();
    const first = await render("graph TD; A-->B");

    expect(peekMermaidRender("graph TD; A-->B", "theme-a")).toEqual(first);
    expect(peekMermaidRender("graph TD; A-->B", "theme-b")).toBeUndefined();
    await render("graph TD; A-->B");
    expect(mermaidMock.render).toHaveBeenCalledTimes(1);
  });

  it("shares one render between concurrent requests for the same diagram", async () => {
    const [a, b] = await Promise.all([render("graph TD; A-->B"), render("graph TD; A-->B")]);
    expect(a).toEqual(b);
    expect(mermaidMock.render).toHaveBeenCalledTimes(1);
  });

  it("runs renders one at a time with distinct ids", async () => {
    let active = 0;
    let maxActive = 0;
    mermaidMock.render.mockImplementation(async (id, text) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, SLOW_RENDER_MS));
      active -= 1;
      return { svg: svgFor(id, text) };
    });

    const results = await Promise.all(
      ["A", "B", "C", "D"].map((label) => render(`graph TD; ${label}`))
    );

    expect(results.every((result) => result.ok)).toBe(true);
    expect(maxActive).toBe(1);
    const ids = mermaidMock.render.mock.calls.map(([id]) => id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps going after one diagram fails", async () => {
    mermaidMock.render.mockRejectedValueOnce(new Error("boom"));
    const [bad, good] = await Promise.all([render("graph TD; bad"), render("graph TD; good")]);
    expect(bad).toEqual({ ok: false });
    expect(good.ok).toBe(true);
  });
});

describe("instantiateMermaidSvg", () => {
  it("gives each mount its own ids, styles and marker references", async () => {
    const result = await render("graph TD; A-->B");
    if (!result.ok) throw new Error("expected a render");

    const one = document.createElement("div");
    one.innerHTML = instantiateMermaidSvg(result, "mount-1");
    const two = document.createElement("div");
    two.innerHTML = instantiateMermaidSvg(result, "mount-2");

    expect(one.querySelector("svg")?.id).toBe("mount-1");
    expect(two.querySelector("svg")?.id).toBe("mount-2");
    expect(one.querySelector("marker")?.id).toBe("mount-1_arrow");
    expect(two.querySelector("path[marker-end]")?.getAttribute("marker-end")).toBe(
      "url(#mount-2_arrow)"
    );
    expect(two.querySelector("style")?.textContent).toContain("#mount-2");
    expect(two.innerHTML).not.toContain(result.templateId);
  });
});
