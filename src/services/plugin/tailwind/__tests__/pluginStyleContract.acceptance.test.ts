// @vitest-environment jsdom
/**
 * The definition of done from #12220, driven against the committed raw-plugin
 * fixture rather than a hand-written class list.
 *
 * Reading the fixture's real source is the point: it exercises both halves of
 * candidate discovery on the same bytes the app loads, so a change to the
 * fixture that quietly stops covering the contract fails here rather than
 * passing while proving nothing.
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

function installedCss(): string {
  return document.querySelector("style[data-daintree-plugin-styles]")?.textContent ?? "";
}

beforeEach(async () => {
  document.body.innerHTML = "";
  document.head.innerHTML = "";
  runtime = await createPluginStyleRuntime(document);
});

afterEach(() => runtime.dispose());

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

  it("leaves a host element carrying the same utilities untouched", () => {
    // The definition-of-done case: a host element with `p-4 px-3` outside any
    // plugin root must be unaffected by a plugin that uses `p-4`. `@scope` is
    // what delivers this, so the assertion is that the generated rules cannot
    // match an unmarked element.
    const hostElement = document.createElement("div");
    hostElement.className = "p-4 px-3";
    document.body.appendChild(hostElement);

    runtime.addSourceText(fixtureSource);

    const css = installedCss();
    expect(css).toContain(`@scope ([${PLUGIN_STYLE_ROOT_ATTRIBUTE}])`);
    expect(hostElement.closest(`[${PLUGIN_STYLE_ROOT_ATTRIBUTE}]`)).toBeNull();
    // No rule sits at column zero, so nothing in this sheet applies document-wide.
    expect(css).not.toMatch(/\n\.[\w\\-]+\s*\{/);
  });

  it("shares one compiler and one sheet across two plugin views in a document", () => {
    for (const classes of ["p-4 bg-surface-panel", "gap-2 text-text-muted"]) {
      const root = document.createElement("div");
      root.setAttribute(PLUGIN_STYLE_ROOT_ATTRIBUTE, "");
      root.innerHTML = `<span class="${classes}"></span>`;
      document.body.appendChild(root);
      runtime.registerRoot(root);
    }

    expect(document.querySelectorAll("style[data-daintree-plugin-styles]")).toHaveLength(1);
    const css = installedCss();
    expect(css).toContain("var(--theme-surface-panel)");
    expect(css).toContain("var(--theme-text-muted)");
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
