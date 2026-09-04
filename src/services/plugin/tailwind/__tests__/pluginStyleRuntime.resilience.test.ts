// @vitest-environment jsdom
/**
 * The runtime's bookkeeping under a failing compiler and during compaction.
 *
 * Separate from `pluginStyleRuntime.test.ts` because these need the compiler
 * itself under test control — to fail on demand, and to be slow enough that
 * something can happen while a new one is being built. The main suite runs
 * against the real compiler, which is the right default; this one trades that
 * for determinism on two paths a real compiler almost never takes.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { PLUGIN_STYLE_ROOT_ATTRIBUTE } from "@shared/types/plugin";

/** Candidates the fake compiler has been handed, in order, per instance. */
const compilerLog: string[][] = [];
/** Set by a test to make the NEXT `build()` throw. */
let failNextBuild = false;
/** Awaited inside `createPluginCssCompiler` when a test wants to hold it open. */
let compileGate: Promise<void> | null = null;

vi.mock("@/services/plugin/tailwind/pluginTailwindAdapter", () => ({
  PLUGIN_SCOPE_SELECTOR: "[data-daintree-plugin-style-root]",
  createPluginCssCompiler: async () => {
    if (compileGate) await compileGate;
    // Cumulative, like the real one: `build()` returns every candidate this
    // instance has ever seen, which is what the runtime's swap logic assumes.
    const seen = new Set<string>();
    return {
      build(candidates: string[]) {
        if (failNextBuild) {
          failNextBuild = false;
          throw new Error("simulated build failure");
        }
        for (const candidate of candidates) seen.add(candidate);
        compilerLog.push([...seen]);
        return [...seen].map((c) => `.${c} { --stub: 1 }`).join("\n");
      },
    };
  },
  createPluginCandidateValidator: async () => (candidates: string[]) =>
    candidates.map((candidate) => ({ candidate, generated: !candidate.startsWith("bad-") })),
}));

const { createPluginStyleRuntime } = await import("@/services/plugin/tailwind/pluginStyleRuntime");

function installedCss(): string {
  return document.querySelector("style[data-daintree-plugin-styles]")?.textContent ?? "";
}

function mountRoot(html = ""): HTMLElement {
  const root = document.createElement("div");
  root.setAttribute(PLUGIN_STYLE_ROOT_ATTRIBUTE, "");
  root.innerHTML = html;
  document.body.appendChild(root);
  return root;
}

async function afterObserver(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  document.body.innerHTML = "";
  document.head.innerHTML = "";
  compilerLog.length = 0;
  failNextBuild = false;
  compileGate = null;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("pluginStyleRuntime — a failed build must not poison its candidates", () => {
  it("re-offers a class to the compiler after its build threw", async () => {
    const runtime = await createPluginStyleRuntime(document);
    try {
      const root = mountRoot();
      runtime.registerRoot(root);

      failNextBuild = true;
      root.innerHTML = `<span class="p-4"></span>`;
      await afterObserver();

      // The build threw, so nothing was installed for `p-4`.
      expect(installedCss()).not.toContain(".p-4");

      // The set that tracks "already handled" must have released it, or `p-4`
      // is unreachable for the life of the document — every later sighting is
      // skipped as already-compiled and the element stays unstyled forever.
      root.innerHTML = `<span class="p-4"></span>`;
      await afterObserver();

      expect(installedCss()).toContain(".p-4");
    } finally {
      runtime.dispose();
    }
  });

  it("keeps the previous sheet when a build throws", async () => {
    const runtime = await createPluginStyleRuntime(document);
    try {
      const root = mountRoot(`<span class="gap-2"></span>`);
      runtime.registerRoot(root);
      expect(installedCss()).toContain(".gap-2");

      failNextBuild = true;
      root.innerHTML = `<span class="gap-2 uppercase"></span>`;
      await afterObserver();

      // Partially styled beats suddenly unstyled.
      expect(installedCss()).toContain(".gap-2");
    } finally {
      runtime.dispose();
    }
  });
});

describe("pluginStyleRuntime — compaction", () => {
  it("drops classes no live root still carries", async () => {
    const runtime = await createPluginStyleRuntime(document, { compactionThreshold: 2 });
    try {
      const first = mountRoot(`<span class="p-1 p-2 p-3"></span>`);
      const unregister = runtime.registerRoot(first);

      unregister();
      first.remove();

      const second = mountRoot(`<span class="p-9"></span>`);
      runtime.registerRoot(second);
      // Compaction is async (it builds a fresh compiler); let it settle.
      await afterObserver();
      await afterObserver();

      expect(installedCss()).toContain(".p-9");
      expect(installedCss()).not.toContain(".p-1");
    } finally {
      runtime.dispose();
    }
  });

  it("keeps a class discovered while compaction was awaiting its new compiler", async () => {
    // Building a compiler is asynchronous and the observer keeps running
    // throughout. A set harvested BEFORE that await, applied after it, erases
    // anything seen in between — and the observer never fires for it again,
    // because the DOM carrying it has not changed since.
    const runtime = await createPluginStyleRuntime(document, { compactionThreshold: 2 });
    try {
      const stale = mountRoot(`<span class="p-1 p-2 p-3"></span>`);
      const unregister = runtime.registerRoot(stale);
      const live = mountRoot(`<span class="p-9"></span>`);
      runtime.registerRoot(live);

      let release: (() => void) | undefined;
      compileGate = new Promise<void>((resolve) => {
        release = resolve;
      });

      // Trigger compaction, then mutate the live root while it is held open.
      unregister();
      stale.remove();
      live.innerHTML = `<span class="p-9 mt-7"></span>`;
      await afterObserver();

      live.innerHTML = `<span class="p-9 mt-7 tracking-wide"></span>`;
      await afterObserver();

      release?.();
      await afterObserver();
      await afterObserver();

      expect(installedCss()).toContain(".tracking-wide");
      expect(installedCss()).toContain(".p-9");
    } finally {
      compileGate = null;
      runtime.dispose();
    }
  });

  it("compacts when a generation swaps in a same-sized, disjoint class set", async () => {
    // The trigger compared set SIZES. A hot reload that replaces every class
    // with an equal number of different ones has everything to drop and
    // identical counts, so a size check declines exactly when it matters — and
    // at the ceiling that leaves the new generation permanently unstyled.
    const runtime = await createPluginStyleRuntime(document, { compactionThreshold: 2 });
    try {
      const root = mountRoot(`<span class="w-1 w-2 w-3"></span>`);
      runtime.registerRoot(root);
      expect(installedCss()).toContain(".w-1");

      root.innerHTML = `<span class="h-1 h-2 h-3"></span>`;
      await afterObserver();
      await afterObserver();
      await afterObserver();

      expect(installedCss()).toContain(".h-1");
      expect(installedCss()).not.toContain(".w-1");
    } finally {
      runtime.dispose();
    }
  });

  it("does not compact while classes are only being added", async () => {
    // Nothing can be dead if nothing was removed, so a purely additive run must
    // not pay for a DOM harvest and a discarded compiler build on every ingest —
    // which is what a size-only trigger did, since a compaction that drops
    // nothing leaves the trigger condition true.
    const runtime = await createPluginStyleRuntime(document, { compactionThreshold: 1 });
    try {
      const root = mountRoot();
      runtime.registerRoot(root);

      for (let i = 0; i < 12; i++) {
        const span = document.createElement("span");
        span.className = `m-${i}`;
        root.appendChild(span);
        await afterObserver();
      }

      // One build per ingest, and no compaction builds on top.
      expect(compilerLog.length).toBeLessThanOrEqual(13);
    } finally {
      runtime.dispose();
    }
  });
});
