// @vitest-environment jsdom
/**
 * Behaviour of the per-document runtime: what gets into the sheet, what stays
 * out of it, and what happens on teardown.
 *
 * These run against the real compiler rather than a mock, because most of what
 * matters here is the seam between the two — that observed classes reach
 * `build()`, that the sheet is replaced rather than appended to, and that host
 * chrome is untouched. jsdom has no constructable stylesheets, so the runtime's
 * `<style>` fallback is what is exercised; the CSS text is identical either way,
 * which is what these assert on.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  createPluginStyleRuntime,
  type PluginStyleRuntime,
} from "@/services/plugin/tailwind/pluginStyleRuntime";
import { tokenizePluginSource } from "@/services/plugin/tailwind/candidateTokenizer";
import { PLUGIN_STYLE_ROOT_ATTRIBUTE } from "@shared/types/plugin";

const FIXTURE = path.resolve(
  import.meta.dirname,
  "../../../../../plugins/fixtures/project-local/.daintree/plugins/acme.project-hello/dist/panel.js"
);

const fixtureSource = readFileSync(FIXTURE, "utf-8");

let runtime: PluginStyleRuntime;

/** The CSS the runtime has installed into this document. */
function installedCss(): string {
  return document.querySelector("style[data-daintree-plugin-styles]")?.textContent ?? "";
}

/** A marked plugin root, as `PluginViewContent` renders one. */
function mountRoot(html = ""): HTMLElement {
  const root = document.createElement("div");
  root.setAttribute(PLUGIN_STYLE_ROOT_ATTRIBUTE, "");
  root.innerHTML = html;
  document.body.appendChild(root);
  return root;
}

/** MutationObserver callbacks are microtasks; this is the paint boundary. */
async function afterObserver(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(async () => {
  document.body.innerHTML = "";
  document.head.innerHTML = "";
  runtime = await createPluginStyleRuntime(document);
});

afterEach(() => {
  runtime.dispose();
});

describe("pluginStyleRuntime — discovery", () => {
  it("compiles the classes already present when a root registers", () => {
    const root = mountRoot(`<span class="p-4 text-text-muted"></span>`);
    runtime.registerRoot(root);

    // Synchronous: an already-mounted subtree is harvested during registration,
    // not on the observer's next turn, so nothing is unstyled in the frame the
    // view first commits.
    expect(installedCss()).toContain(".p-4");
    expect(installedCss()).toContain("var(--theme-text-muted)");
  });

  it("styles a class added after mount, before the next paint", async () => {
    const root = mountRoot(`<span class="p-4"></span>`);
    runtime.registerRoot(root);
    expect(installedCss()).not.toContain(".gap-2");

    root.querySelector("span")?.classList.add("gap-2");
    await afterObserver();

    // The observer callback is a microtask, so this lands in the same task the
    // class was added in — a state toggle is styled in the frame it happens.
    expect(installedCss()).toContain(".gap-2");
  });

  it("picks up classes on a subtree inserted after mount", async () => {
    const root = mountRoot();
    runtime.registerRoot(root);

    const child = document.createElement("div");
    child.innerHTML = `<b class="rounded-md"></b>`;
    root.appendChild(child);
    await afterObserver();

    expect(installedCss()).toContain(".rounded-md");
  });

  it("ignores classes outside every registered root", async () => {
    // Harvesting the whole document is what would let host chrome into the
    // plugin sheet, and the plugin sheet is scoped — so host classes there
    // would be dead weight at best.
    const root = mountRoot();
    runtime.registerRoot(root);

    const outsider = document.createElement("div");
    outsider.className = "tracking-widest";
    document.body.appendChild(outsider);
    await afterObserver();

    expect(installedCss()).not.toContain("tracking-widest");
  });

  it("compiles speculative classes from source text", () => {
    runtime.addSourceText(`export const cls = "bg-surface-panel w-[327px]";`);

    expect(installedCss()).toContain("var(--theme-surface-panel)");
    expect(installedCss()).toContain("width: 327px");
  });
});

describe("pluginStyleRuntime — the sheet", () => {
  it("scopes every rule to the plugin style root", () => {
    const root = mountRoot(`<span class="p-4 px-3 flex"></span>`);
    runtime.registerRoot(root);

    const css = installedCss();
    expect(css).toContain(`@scope ([${PLUGIN_STYLE_ROOT_ATTRIBUTE}])`);
    // The load-bearing guarantee: a host element carrying `p-4 px-3` cannot be
    // touched by a plugin that uses `p-4`, because every generated rule sits
    // inside the scope. A rule at column zero would be outside it.
    expect(css).not.toMatch(/\n\.[\w\\-]+\s*\{/);
    expect(css.indexOf("@scope (")).toBeLessThan(css.indexOf(".p-4"));
  });

  it("replaces the sheet rather than appending, keeping Tailwind's order", async () => {
    const root = mountRoot(`<span class="px-3"></span>`);
    runtime.registerRoot(root);

    root.querySelector("span")?.classList.add("p-4");
    await afterObserver();

    const css = installedCss();
    // `p-4` was discovered second but must still sort first. Appending a delta
    // would have put it last and let `px-3` lose to it.
    expect(css.indexOf(".p-4")).toBeLessThan(css.indexOf(".px-3"));
  });

  it("keeps one sheet no matter how many roots register", () => {
    runtime.registerRoot(mountRoot(`<span class="p-4"></span>`));
    runtime.registerRoot(mountRoot(`<span class="gap-2"></span>`));

    expect(document.querySelectorAll("style[data-daintree-plugin-styles]")).toHaveLength(1);
    expect(installedCss()).toContain(".p-4");
    expect(installedCss()).toContain(".gap-2");
  });

  it("does not rewrite the sheet when no new class appears", async () => {
    const root = mountRoot(`<span class="p-4"></span>`);
    runtime.registerRoot(root);
    const sheet = document.querySelector("style[data-daintree-plugin-styles]");
    const before = sheet?.textContent;

    // Re-adding a known class is the common case for a re-rendering view. It
    // must not reinstall the sheet: a replacement re-registers the output's
    // `@property` rules, which is the expensive part of installing this CSS.
    root.querySelector("span")?.classList.add("p-4");
    await afterObserver();

    expect(sheet?.textContent).toBe(before);
  });
});

describe("pluginStyleRuntime — lifecycle", () => {
  it("keeps watching the other roots when one unregisters", async () => {
    // The scope the CSS is generated for is "inside a marked root", so that is
    // what the observer follows. Unregistering is liveness bookkeeping — it must
    // never leave a still-mounted sibling unwatched, which is exactly what
    // per-root observation did: `MutationObserver` cannot drop one target, so
    // detaching one root meant disconnecting from all of them.
    const kept = mountRoot();
    const removed = mountRoot();
    runtime.registerRoot(kept);
    const unregister = runtime.registerRoot(removed);

    unregister();
    removed.remove();

    kept.innerHTML = `<span class="uppercase"></span>`;
    await afterObserver();
    expect(installedCss()).toContain("uppercase");
  });

  it("styles a container marked after its content is already in place", async () => {
    // A hand-written view can append a portal container and mark it afterwards.
    // The content's own records were emitted while it was still outside every
    // plugin root, so becoming a root is the only signal left to act on.
    runtime.registerRoot(mountRoot());

    const portal = document.createElement("div");
    portal.innerHTML = `<span class="tracking-tighter"></span>`;
    document.body.appendChild(portal);
    await afterObserver();
    expect(installedCss()).not.toContain("tracking-tighter");

    portal.setAttribute(PLUGIN_STYLE_ROOT_ATTRIBUTE, "");
    await afterObserver();

    expect(installedCss()).toContain("tracking-tighter");
  });

  it("styles a marked portal container rendered outside the view wrapper", async () => {
    // `createPortal` escapes the wrapper the host registered, which is why
    // `PanelViewProps.styleRootAttributes` exists. The generated CSS is scoped to
    // the marker, so the observer has to follow the marker too — otherwise the
    // contract compiles rules for a subtree it never looks at.
    runtime.registerRoot(mountRoot());

    const portal = document.createElement("div");
    portal.setAttribute(PLUGIN_STYLE_ROOT_ATTRIBUTE, "");
    portal.innerHTML = `<span class="tracking-tight"></span>`;
    document.body.appendChild(portal);
    await afterObserver();

    expect(installedCss()).toContain("tracking-tight");
  });

  it("removes its stylesheet and stops observing on dispose", async () => {
    const root = mountRoot(`<span class="p-4"></span>`);
    runtime.registerRoot(root);
    expect(installedCss()).toContain(".p-4");

    runtime.dispose();
    expect(document.querySelector("style[data-daintree-plugin-styles]")).toBeNull();

    root.innerHTML = `<span class="gap-2"></span>`;
    await afterObserver();
    expect(installedCss()).toBe("");
  });

  it("is safe to dispose twice", () => {
    runtime.dispose();
    expect(() => runtime.dispose()).not.toThrow();
  });
});

describe("pluginStyleRuntime — diagnostics", () => {
  it("reports DOM classes as generated or not", async () => {
    const root = mountRoot(`<span class="bg-surface-panel bg-red-500 w-[327px]"></span>`);
    runtime.registerRoot(root);

    const report = await runtime.getReport();

    expect(report.generated).toEqual(expect.arrayContaining(["bg-surface-panel", "w-[327px]"]));
    // The headline diagnostic from the issue: a stock-palette colour is
    // reported rather than silently doing nothing.
    expect(report.notGenerated).toContain("bg-red-500");
  });

  it("excludes speculative source tokens from the report", async () => {
    // Source tokenisation is heuristic and full of strings that were never
    // classes. Reporting them would make the diagnostics useless.
    runtime.addSourceText(`"definitely-not-a-class bg-surface-panel"`);
    runtime.registerRoot(mountRoot(`<span class="p-4"></span>`));

    const report = await runtime.getReport();

    expect(report.generated).toEqual(["p-4"]);
    expect(report.notGenerated).toEqual([]);
  });
});

// The definition of done from #12220, driven against the committed raw-plugin
// fixture rather than a hand-written class list. Reading the fixture's real
// source exercises both halves of candidate discovery on the same bytes the app
// loads, so a change to the fixture that quietly stops covering the contract
// fails here rather than passing while proving nothing.
describe("plugin styling contract — the raw project-plugin fixture", () => {
  it("still exercises the contract", () => {
    // Guards the fixture itself. Every class below is load-bearing for one of
    // the assertions in this file.
    const tokens = new Set(tokenizePluginSource(fixtureSource));
    for (const required of [
      "bg-surface-panel",
      "text-text-muted",
      "hover:bg-surface-hover",
      "gap-2",
      "p-4",
      "rounded-md",
      "w-[327px]",
      "bg-red-500",
    ]) {
      expect(tokens, `fixture no longer uses ${required}`).toContain(required);
    }
  });

  it("compiles every contract class from source text alone, before the view mounts", () => {
    // The source pass is what makes the FIRST paint styled — the observer only
    // gets a turn once the DOM exists.
    runtime.addSourceText(fixtureSource);
    const css = installedCss();

    expect(css).toContain("var(--theme-surface-panel)");
    expect(css).toContain("var(--theme-text-muted)");
    expect(css).toContain("var(--theme-surface-hover)");
    expect(css).toContain("width: 327px");
    expect(css).toMatch(/\.gap-2\s*\{/);
    expect(css).toMatch(/\.p-4\s*\{/);
    expect(css).toMatch(/\.rounded-md\s*\{/);
  });

  it("generates no rule for the stock-palette class and reports it", async () => {
    runtime.addSourceText(fixtureSource);

    const root = document.createElement("div");
    root.setAttribute(PLUGIN_STYLE_ROOT_ATTRIBUTE, "");
    root.innerHTML = `<span class="bg-red-500 bg-surface-panel"></span>`;
    document.body.appendChild(root);
    runtime.registerRoot(root);

    expect(installedCss()).not.toContain("bg-red-500");

    const report = await runtime.getReport();
    expect(report.notGenerated).toContain("bg-red-500");
    expect(report.generated).toContain("bg-surface-panel");
  });

  it("keeps styling across hot-reload generations", async () => {
    // Each `__dtv-N` generation re-registers a fresh root with the same runtime.
    // Styling has to survive that, and the sheet must still describe what is on
    // screen rather than accumulating every generation's leftovers forever.
    const mountGeneration = (classes: string): (() => void) => {
      const root = document.createElement("div");
      root.setAttribute(PLUGIN_STYLE_ROOT_ATTRIBUTE, "");
      root.innerHTML = `<span class="${classes}"></span>`;
      document.body.appendChild(root);
      const unregister = runtime.registerRoot(root);
      return () => {
        unregister();
        root.remove();
      };
    };

    let teardown = mountGeneration("p-4 bg-surface-panel");
    for (const classes of ["gap-2 rounded-md", "px-3 text-text-muted"]) {
      teardown();
      teardown = mountGeneration(classes);
    }

    expect(installedCss()).toMatch(/\.px-3\s*\{/);
    expect(installedCss()).toContain("var(--theme-text-muted)");
    teardown();
  });
});
