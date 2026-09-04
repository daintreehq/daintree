/**
 * The per-document Tailwind runtime for plugin views.
 *
 * One compiler and one stylesheet serve every plugin root in a document. Each
 * project view is its own `WebContentsView` with its own V8 context, so a module
 * singleton here is already per-document — and a constructed `CSSStyleSheet`
 * belongs to the document that made it, so sharing one across documents is not
 * merely wasteful but invalid.
 *
 * Candidate discovery has two sources, and only one of them is authoritative:
 *
 *   1. Source text, tokenised before the view module is imported
 *      (`candidateTokenizer`). Heuristic. It exists so the first paint — and any
 *      `useLayoutEffect` that measures during it — already has CSS.
 *   2. A `MutationObserver` over the registered plugin roots. Authoritative. It
 *      reads `classList`, so it sees classes built from template literals,
 *      imported sibling modules, and anything computed at runtime. Its callback
 *      is a microtask, so a synchronous `build()` + `replaceSync()` inside it
 *      lands before the browser's next paint: a class toggled on by state is
 *      styled in the same frame it appears.
 *
 * The whole document is never harvested. The observer is attached to plugin
 * roots only, which is what keeps host chrome out of the plugin sheet.
 */

import { createPluginCssCompiler, type PluginCssCompiler } from "./pluginTailwindAdapter";
import { tokenizePluginSource } from "./candidateTokenizer";
import { logWarn } from "@/utils/logger";

/**
 * Candidate count at which the compiler is rebuilt from the classes actually
 * present in the live DOM.
 *
 * `build()` is cumulative and never forgets, which is correct for the cascade
 * but means a long dev session — every plugin hot-reload generation
 * (`__dtv-N`), every arbitrary value a slider produced — grows the sheet
 * monotonically. Compaction drops everything no live root still uses.
 */
const COMPACTION_THRESHOLD = 4096;

/** Hard ceiling. Reached only if a single generation is pathological. */
const MAX_TRACKED_CANDIDATES = 16_384;

/** What the diagnostics surface reports for a plugin's classes (#12214). */
export interface PluginStyleReport {
  /** DOM classes that compiled to CSS. */
  readonly generated: readonly string[];
  /**
   * DOM classes that look like Tailwind but produced nothing — a stock-palette
   * colour, a typo, a class from a Tailwind version we do not run.
   */
  readonly notGenerated: readonly string[];
}

export interface PluginStyleRuntime {
  /**
   * Bring `root`'s subtree into the styling contract: harvest the classes
   * already on it and watch it for more. Returns the unregister function.
   */
  registerRoot(root: Element): () => void;
  /**
   * Feed candidates from plugin source text, ahead of the view mounting. These
   * are speculative and are deliberately excluded from {@link getReport}.
   */
  addSourceText(source: string): void;
  /** Classify every class observed in plugin DOM. Compiles a design system on
   * first call, so it is on-demand rather than part of the mount path. */
  getReport(): Promise<PluginStyleReport>;
  /** Detach the observer and remove the stylesheet from the document. */
  dispose(): void;
}

/** Where generated CSS is installed. Abstracted so the fallback is testable. */
interface StyleSink {
  replace(css: string): void;
  dispose(): void;
}

/**
 * Prefer a constructed stylesheet on `adoptedStyleSheets`: it is replaced
 * wholesale without re-parsing the document's own CSS, and it is removed by
 * dropping a reference. A `<style>` element is the fallback for environments
 * without constructable stylesheets (jsdom, notably), so the runtime under test
 * is the runtime that ships rather than a mock of it.
 */
function createStyleSink(doc: Document): StyleSink {
  const supportsConstructedSheets =
    typeof CSSStyleSheet === "function" &&
    "adoptedStyleSheets" in doc &&
    (() => {
      try {
        new CSSStyleSheet();
        return true;
      } catch {
        return false;
      }
    })();

  if (supportsConstructedSheets) {
    const sheet = new CSSStyleSheet();
    doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet];
    return {
      replace: (css) => sheet.replaceSync(css),
      dispose: () => {
        doc.adoptedStyleSheets = doc.adoptedStyleSheets.filter((s) => s !== sheet);
      },
    };
  }

  const element = doc.createElement("style");
  element.setAttribute("data-daintree-plugin-styles", "");
  doc.head.appendChild(element);
  return {
    replace: (css) => {
      element.textContent = css;
    },
    dispose: () => element.remove(),
  };
}

/** Every class on `root` and its descendants. */
function harvestClasses(root: Element, into: Set<string>): void {
  for (const token of root.classList) into.add(token);
  for (const element of root.querySelectorAll("[class]")) {
    for (const token of element.classList) into.add(token);
  }
}

export async function createPluginStyleRuntime(
  doc: Document = document
): Promise<PluginStyleRuntime> {
  let compiler: PluginCssCompiler = await createPluginCssCompiler();
  const sink = createStyleSink(doc);

  /** Everything handed to the compiler, source-speculative included. */
  const compiled = new Set<string>();
  /** Classes actually seen in plugin DOM — the only ones diagnostics report. */
  const observedInDom = new Set<string>();
  const roots = new Set<Element>();

  let lastGoodCss = "";
  let compacting = false;
  let disposed = false;

  const observer = new MutationObserver((records) => {
    const pending = new Set<string>();
    for (const record of records) {
      if (record.type === "attributes") {
        if (record.target instanceof Element) {
          for (const token of record.target.classList) pending.add(token);
        }
        continue;
      }
      for (const node of record.addedNodes) {
        if (node instanceof Element) harvestClasses(node, pending);
      }
    }
    ingest(pending, true);
  });

  /**
   * Add candidates and, if any are new, regenerate the sheet.
   *
   * Rebuilding only when the set actually grew is what keeps `replaceSync()`
   * rare: a plugin that re-renders constantly with a stable class set never
   * touches the stylesheet after its first build. That matters because a
   * replacement re-registers the output's `@property` rules, which is the
   * expensive part of installing this CSS — not the utility rules.
   */
  function ingest(tokens: Iterable<string>, fromDom: boolean): void {
    if (disposed) return;

    const added: string[] = [];
    for (const token of tokens) {
      if (fromDom) observedInDom.add(token);
      if (compiled.has(token)) continue;
      if (compiled.size + added.length >= MAX_TRACKED_CANDIDATES) {
        logWarn("[pluginStyleRuntime] candidate ceiling reached; ignoring further classes", {
          ceiling: MAX_TRACKED_CANDIDATES,
        });
        break;
      }
      added.push(token);
    }
    if (added.length === 0) return;

    for (const token of added) compiled.add(token);
    rebuild(added);

    if (compiled.size > COMPACTION_THRESHOLD) void compact();
  }

  /**
   * Regenerate and install. `build()` returns the cumulative stylesheet rather
   * than a delta — a newly discovered utility can sort ahead of one already
   * emitted — so the sheet is replaced wholesale, never appended to.
   *
   * A replacement that throws leaves the previous sheet in place: partially
   * styled is a far better failure than suddenly unstyled.
   */
  function rebuild(added: string[]): void {
    try {
      const css = compiler.build(added);
      sink.replace(css);
      lastGoodCss = css;
    } catch (error) {
      logWarn("[pluginStyleRuntime] failed to install plugin styles; keeping the previous sheet", {
        error: error instanceof Error ? error.message : String(error),
        candidates: added.length,
      });
      if (lastGoodCss) {
        try {
          sink.replace(lastGoodCss);
        } catch {
          // The sink itself is unusable; nothing further to try.
        }
      }
    }
  }

  /**
   * Rebuild the compiler from the classes live roots currently carry, dropping
   * everything a hot-reload generation or a transient arbitrary value left
   * behind. Asynchronous (a fresh compile is ~10 ms) and never concurrent; the
   * existing sheet stays installed throughout, so nothing flashes.
   */
  async function compact(): Promise<void> {
    if (compacting || disposed) return;
    compacting = true;
    try {
      const live = new Set<string>();
      for (const root of roots) harvestClasses(root, live);
      if (live.size >= compiled.size) return;

      const fresh = await createPluginCssCompiler();
      if (disposed) return;

      compiler = fresh;
      compiled.clear();
      for (const token of live) compiled.add(token);
      // Classes no longer in the DOM are dropped from diagnostics too — a
      // report about a generation that no longer exists is noise.
      for (const token of observedInDom) {
        if (!live.has(token)) observedInDom.delete(token);
      }
      rebuild([...live]);
    } catch (error) {
      logWarn("[pluginStyleRuntime] compaction failed; keeping the existing compiler", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      compacting = false;
    }
  }

  return {
    registerRoot(root) {
      if (disposed) return () => {};
      roots.add(root);
      // `attributeOldValue` is deliberately off: the runtime only ever adds
      // candidates, so the previous value of a `class` attribute is not
      // information it can act on.
      observer.observe(root, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["class"],
      });

      const existing = new Set<string>();
      harvestClasses(root, existing);
      ingest(existing, true);

      return () => {
        if (!roots.delete(root)) return;
        // A MutationObserver cannot drop a single target, so re-observe what is
        // left. Roots are per mounted plugin view, so this set is tiny.
        observer.disconnect();
        for (const remaining of roots) {
          observer.observe(remaining, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ["class"],
          });
        }
      };
    },

    addSourceText(source) {
      ingest(tokenizePluginSource(source), false);
    },

    async getReport() {
      const { createPluginCandidateValidator } = await import("./pluginTailwindAdapter");
      const validate = await createPluginCandidateValidator();
      const generated: string[] = [];
      const notGenerated: string[] = [];
      for (const verdict of validate([...observedInDom])) {
        (verdict.generated ? generated : notGenerated).push(verdict.candidate);
      }
      return { generated, notGenerated };
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      observer.disconnect();
      roots.clear();
      sink.dispose();
    },
  };
}
