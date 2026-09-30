// @vitest-environment jsdom
/**
 * The per-plugin Styles check against real kit markup and the real plugin
 * compiler. Kit components render host component classes (`search-field`,
 * `toolbar-icon-button`, Lucide's markers) that the plugin's Tailwind never
 * generates; the report must not hand those to the author as their problem.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { PLUGIN_STYLE_ROOT_ATTRIBUTE } from "@shared/types/plugin";
import { primeRadix } from "@/components/ui/radix-loader";
import { TooltipProvider } from "@/components/ui/tooltip";

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn(() => Promise.resolve()) },
}));

import * as kit from "@daintreehq/plugin-ui";
import { getPluginStyleReportForRoots } from "@/services/plugin/pluginStyleContract";

const SEARCH_FIELD_CSS = readFileSync(
  path.resolve(__dirname, "../../../styles/components/search-field.css"),
  "utf-8"
);

// The host's global stylesheet, reduced to the component rules the kit leans
// on here; the full `index.css` is Tailwind source, not parseable CSS.
function installHostStyles(): void {
  for (const css of [
    SEARCH_FIELD_CSS,
    "@layer components { .toolbar-icon-button { display: inline-flex; } .palette-row { display: flex; } }",
    ".border-divider { border-color: var(--border-divider); }",
    // A host class that styles only inside host chrome; a plugin class of the
    // same name elsewhere is not styled by it.
    ".host-toolbar .status { color: red; } .status.host-only::before { content: ''; }",
  ]) {
    const style = document.createElement("style");
    style.textContent = css;
    document.head.appendChild(style);
  }
}

beforeAll(async () => {
  await primeRadix();
  await kit.whenPluginUiReady();
  installHostStyles();
}, 30000);

afterEach(cleanup);

function renderPluginRoot(): Element {
  const { container } = render(
    createElement(
      TooltipProvider,
      null,
      createElement(
        "div",
        { [PLUGIN_STYLE_ROOT_ATTRIBUTE]: "", className: "group flex p-4" },
        createElement(kit.Button, { icon: "refresh" }, "Refresh"),
        createElement(kit.IconButton, { icon: "x", "aria-label": "Close" }),
        createElement(kit.Icon, { name: "search", className: "text-text-secondary" }),
        createElement(kit.SearchField, { value: "", "aria-label": "Search" }),
        createElement("div", { className: "border-b border-divider plugin-typo-class" }),
        // Lucide's prefix on the author's own element is still checked.
        createElement("span", { className: "lucide-typo" })
      )
    )
  );
  const root = container.querySelector(`[${PLUGIN_STYLE_ROOT_ATTRIBUTE}]`);
  if (!root) throw new Error("no plugin root");
  return root;
}

describe("getPluginStyleReportForRoots with kit markup", () => {
  it("renders the kit's host classes that the plugin compiler cannot generate", async () => {
    const root = renderPluginRoot();
    await vi.waitFor(() => {
      if (!root.querySelector(".search-field")) throw new Error("kit not rendered");
    });
    const tokens = new Set(
      [root, ...root.querySelectorAll("[class]")].flatMap((element) => [...element.classList])
    );
    expect(tokens.has("lucide")).toBe(true);
    expect(tokens.has("search-field")).toBe(true);
  });

  it("flags only the plugin's own class that produced no CSS", async () => {
    const root = renderPluginRoot();
    await vi.waitFor(() => {
      if (!root.querySelector(".search-field")) throw new Error("kit not rendered");
    });
    const report = await getPluginStyleReportForRoots([root]);
    expect([...(report?.notGenerated ?? [])].sort()).toEqual(["lucide-typo", "plugin-typo-class"]);
    expect(report?.generated).toEqual(
      expect.arrayContaining(["search-field", "border-divider", "p-4", "text-text-secondary"])
    );
    expect(report?.generated.some((name) => name.startsWith("lucide"))).toBe(false);
    expect(report?.generated).not.toContain("group");
  });

  it("re-reads a stylesheet whose rules changed in place", async () => {
    const root = document.createElement("div");
    root.className = "late-host-class";
    const style = document.createElement("style");
    document.head.appendChild(style);
    const sheet = style.sheet!;
    expect((await getPluginStyleReportForRoots([root]))?.notGenerated).toEqual(["late-host-class"]);
    sheet.insertRule(".late-host-class { color: red; }");
    expect((await getPluginStyleReportForRoots([root]))?.generated).toEqual(["late-host-class"]);
    sheet.deleteRule(0);
    expect((await getPluginStyleReportForRoots([root]))?.notGenerated).toEqual(["late-host-class"]);
    style.remove();
  });

  it("still reports a plugin class that collides with a host class the host styles elsewhere", async () => {
    const root = renderPluginRoot();
    const mine = document.createElement("span");
    mine.className = "status";
    root.appendChild(mine);
    await vi.waitFor(() => {
      if (!root.querySelector(".search-field")) throw new Error("kit not rendered");
    });
    const report = await getPluginStyleReportForRoots([root]);
    expect(report?.notGenerated).toContain("status");
    expect(report?.generated).toContain("search-field");
  });

  it("counts a host class where the host's rule selects the element carrying it", async () => {
    const toolbar = document.createElement("div");
    toolbar.className = "host-toolbar";
    const status = document.createElement("span");
    status.className = "status";
    toolbar.appendChild(status);
    document.body.appendChild(toolbar);
    const report = await getPluginStyleReportForRoots([status]);
    expect(report?.generated).toEqual(["status"]);
    toolbar.remove();
  });

  it("reads classes as selector tokens and relaxes negated states", async () => {
    const style = document.createElement("style");
    style.textContent =
      '[data-kind=".quoted-class"] { color: red; } [data-kind="] .quoted-class"] { color: red; } .calm-class:not(:hover) { color: red; }';
    document.head.appendChild(style);
    try {
      const quoted = document.createElement("span");
      quoted.className = "quoted-class";
      quoted.setAttribute("data-kind", ".quoted-class");
      const calm = document.createElement("span");
      calm.className = "calm-class";
      const report = await getPluginStyleReportForRoots([quoted, calm]);
      expect(report?.notGenerated).toContain("quoted-class");
      expect(report?.generated).toContain("calm-class");
    } finally {
      style.remove();
    }
  });

  it("re-reads a constructed sheet replaced in place with the same rule count", async () => {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(".replaced-host-class { color: red; }");
    Object.defineProperty(document, "adoptedStyleSheets", {
      configurable: true,
      value: [sheet],
    });
    try {
      const root = document.createElement("div");
      root.className = "replaced-host-class";
      expect((await getPluginStyleReportForRoots([root]))?.generated).toEqual([
        "replaced-host-class",
      ]);
      sheet.replaceSync(".some-other-class { color: red; }");
      expect((await getPluginStyleReportForRoots([root]))?.notGenerated).toEqual([
        "replaced-host-class",
      ]);
    } finally {
      delete (document as { adoptedStyleSheets?: unknown }).adoptedStyleSheets;
    }
  });
});
