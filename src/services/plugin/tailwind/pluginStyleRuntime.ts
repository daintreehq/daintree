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
 *   2. A `MutationObserver`, authoritative. It reads `classList`, so it sees
 *      classes built from template literals, imported sibling modules, and
 *      anything computed at runtime. Its callback is a microtask, so a
 *      synchronous `build()` + `replaceSync()` inside it lands before the
 *      browser's next paint: a class toggled on by state is styled in the same
 *      frame it appears.
 *
 * The observer watches the document but keeps only what is inside a marked
 * plugin root, which every record is checked against with one `closest()` call.
 * Watching per-root instead was tried and is wrong twice over: a
 * `MutationObserver` cannot drop a single target, so unregistering one root has
 * to `disconnect()` — silently discarding every other root's queued records —
 * and a `createPortal` container, which the styling contract explicitly
 * supports through `PanelViewProps.styleRootAttributes`, is never a descendant
 * of the wrapper it was rendered from. Filtering by the marker is what makes
 * the observed set match the set the generated CSS is scoped to.
 */

import { createPluginCssCompiler, type PluginCssCompiler } from "./pluginTailwindAdapter";
import { tokenizePluginSource } from "./candidateTokenizer";
import { logWarn } from "@/utils/logger";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { PLUGIN_STYLE_ROOT_ATTRIBUTE } from "@shared/types/plugin";

/** CSS selector for a marked plugin style root, portal containers included. */
const STYLE_ROOT_SELECTOR = `[${PLUGIN_STYLE_ROOT_ATTRIBUTE}]`;

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

/**
 * How much the candidate set must grow before compaction is attempted again
 * after one that found nothing to drop. Without a gap, the trigger condition
 * stays true and every subsequent ingest pays for a full DOM harvest.
 */
const COMPACTION_RETRY_GROWTH = 512;

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

export interface PluginStyleRuntimeOptions {
  /**
   * Candidate count that triggers compaction. A seam for tests: the production
   * threshold is thousands of classes, which no test should have to synthesise
   * to exercise the swap.
   */
  readonly compactionThreshold?: number;
  /**
   * Called after a compaction has discarded candidates.
   *
   * Compaction rebuilds from live DOM, which necessarily drops candidates that
   * only ever came from a view's source text — a view prepared, then unmounted,
   * then remounted would otherwise be served a cached "already prepared" promise
   * against a compiler that has since forgotten its classes.
   */
  readonly onCompacted?: () => void;
}

export async function createPluginStyleRuntime(
  doc: Document = document,
  options: PluginStyleRuntimeOptions = {}
): Promise<PluginStyleRuntime> {
  const compactionThreshold = options.compactionThreshold ?? COMPACTION_THRESHOLD;
  let compiler: PluginCssCompiler = await createPluginCssCompiler();
  const sink = createStyleSink(doc);

  /** Everything handed to the compiler, source-speculative included. */
  const compiled = new Set<string>();
  /** Classes actually seen in plugin DOM — the only ones diagnostics report. */
  const observedInDom = new Set<string>();
  /**
   * Registered wrappers, reference-counted. Registration governs liveness
   * bookkeeping only; what the observer watches is decided by the marker in the
   * live document, so a portal container counts without ever being registered.
   * Counted rather than a plain Set because two registrations of the same
   * element must both be released before it stops counting as live.
   */
  const roots = new Map<Element, number>();

  let lastGoodCss = "";
  let compacting = false;
  let disposed = false;
  /** Candidate count at which compaction is worth attempting again. */
  let compactionFloor = compactionThreshold;

  const observer = new MutationObserver((records) => {
    const pending = new Set<string>();
    for (const record of records) {
      if (record.type === "attributes") {
        const target = record.target;
        if (!(target instanceof Element)) continue;
        if (record.attributeName === PLUGIN_STYLE_ROOT_ATTRIBUTE) {
          // An element just BECAME a style root. Its subtree may already be
          // populated — a portal container marked after it was appended — and
          // that content produced no record of its own, so harvest it whole.
          if (target.hasAttribute(PLUGIN_STYLE_ROOT_ATTRIBUTE)) harvestClasses(target, pending);
          continue;
        }
        if (target.closest(STYLE_ROOT_SELECTOR)) {
          for (const token of target.classList) pending.add(token);
        }
        continue;
      }
      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue;
        if (node.closest(STYLE_ROOT_SELECTOR)) {
          harvestClasses(node, pending);
          continue;
        }
        // The node is outside every plugin root, but it may CONTAIN one — a
        // portal container mounted with its content already in place, or a host
        // subtree that brings a plugin panel with it.
        for (const marked of node.querySelectorAll(STYLE_ROOT_SELECTOR)) {
          harvestClasses(marked, pending);
        }
      }
    }
    if (pending.size > 0) ingest(pending, true);
  });

  // One observer over the document, not one per registered root. Per-root
  // observation cannot be undone selectively — `disconnect()` is all-or-nothing
  // and discards every root's queued records — and it cannot see a portal.
  observer.observe(doc, {
    childList: true,
    subtree: true,
    attributes: true,
    // `attributeOldValue` is deliberately off: the runtime only ever adds
    // candidates, so the previous value of a `class` attribute tells it nothing.
    // The marker is watched alongside `class` because an element can become a
    // style root after its content is already in place, and that content
    // generated its records while it was still outside every plugin root.
    attributeFilter: ["class", PLUGIN_STYLE_ROOT_ATTRIBUTE],
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
        logWarn(
          "[pluginStyleRuntime] candidate ceiling reached; compacting before accepting more",
          {
            ceiling: MAX_TRACKED_CANDIDATES,
          }
        );
        // Most of a full set is usually dead by the time the ceiling is reached
        // — hot-reload generations and transient arbitrary values. Compacting
        // here is what lets a legitimate new class through afterwards; without
        // it `added` stays empty, the early return below skips the compaction
        // check entirely, and the ceiling is permanent.
        void compact();
        break;
      }
      added.push(token);
    }
    if (added.length === 0) return;

    for (const token of added) compiled.add(token);
    if (!rebuild(added)) {
      // Forget them again, or they are poisoned for the life of the document:
      // `compiled` is what makes a candidate "already handled", so leaving a
      // failed batch in it means those classes are never offered to the
      // compiler again and the elements wearing them stay unstyled forever.
      // Re-offering them is safe — `build()` is cumulative and idempotent.
      for (const token of added) compiled.delete(token);
      return;
    }

    maybeCompact();
  }

  /**
   * Regenerate and install, reporting whether it worked.
   *
   * `build()` returns the cumulative stylesheet rather than a delta — a newly
   * discovered utility can sort ahead of one already emitted — so the sheet is
   * replaced wholesale, never appended to.
   *
   * A replacement that throws leaves the previous sheet in place: partially
   * styled is a far better failure than suddenly unstyled.
   */
  function rebuild(added: string[]): boolean {
    try {
      const css = compiler.build(added);
      sink.replace(css);
      lastGoodCss = css;
      return true;
    } catch (error) {
      logWarn("[pluginStyleRuntime] failed to install plugin styles; keeping the previous sheet", {
        error: formatErrorMessage(error, "unknown error"),
        candidates: added.length,
      });
      if (lastGoodCss) {
        try {
          sink.replace(lastGoodCss);
        } catch {
          // The sink itself is unusable; nothing further to try.
        }
      }
      return false;
    }
  }

  /**
   * Consider compacting, at most once per meaningful growth step.
   *
   * Without the high-water mark this re-ran a full DOM harvest on every single
   * ingest once the set passed the threshold: compaction that finds nothing to
   * drop returns without shrinking `compiled`, so the trigger condition stayed
   * true forever.
   */
  function maybeCompact(): void {
    if (compiled.size <= compactionThreshold) return;
    if (compiled.size < compactionFloor) return;
    compactionFloor = compiled.size + COMPACTION_RETRY_GROWTH;
    void compact();
  }

  /**
   * Rebuild the compiler from the classes the live document currently carries,
   * dropping everything a hot-reload generation or a transient arbitrary value
   * left behind. Asynchronous (a fresh compile is ~10 ms) and never concurrent;
   * the existing sheet stays installed throughout, so nothing flashes.
   *
   * Transactional: the new compiler has to produce installable CSS before any
   * state moves to it. Committing first and building second would, on a build
   * failure, leave `compiler` and `compiled` describing a compiler that never
   * emitted anything — every live class marked as handled by a compiler that
   * has not seen it, and so never re-offered.
   */
  async function compact(): Promise<void> {
    if (compacting || disposed) return;
    compacting = true;
    try {
      if (liveClasses().size >= compiled.size) return;

      const fresh = await createPluginCssCompiler();
      if (disposed) return;

      // Re-harvest AFTER the await, never before it. Building a fresh compiler
      // takes ~10 ms, and the observer keeps running throughout: a class that
      // appeared in that window is already in `compiled` and already in the old
      // sheet, so swapping in a set harvested beforehand would erase it from
      // both — and the observer will not fire for it again, because the DOM
      // carrying it has not changed since. It would stay unstyled for good.
      const live = liveClasses();

      const css = fresh.build([...live]);
      sink.replace(css);

      // Only now is the swap safe to record.
      compiler = fresh;
      lastGoodCss = css;
      compiled.clear();
      for (const token of live) compiled.add(token);
      // Classes no longer in the DOM are dropped from diagnostics too — a
      // report about a generation that no longer exists is noise.
      for (const token of observedInDom) {
        if (!live.has(token)) observedInDom.delete(token);
      }
      compactionFloor = compiled.size + COMPACTION_RETRY_GROWTH;
      // Source-only candidates are gone now, so a view whose preparation was
      // memoised must be allowed to prepare again on its next mount.
      options.onCompacted?.();
    } catch (error) {
      logWarn("[pluginStyleRuntime] compaction failed; keeping the existing compiler", {
        error: formatErrorMessage(error, "unknown error"),
      });
    } finally {
      compacting = false;
    }
  }

  /**
   * Every class currently inside a marked style root anywhere in the document.
   *
   * Queried from the document rather than walked from the registered wrappers,
   * so a `createPortal` container carrying the marker counts as live. Harvesting
   * only registered wrappers would let compaction drop a mounted portal's
   * classes, leaving a subtree that is still on screen suddenly unstyled.
   */
  function liveClasses(): Set<string> {
    const live = new Set<string>();
    for (const root of doc.querySelectorAll(STYLE_ROOT_SELECTOR)) harvestClasses(root, live);
    return live;
  }

  return {
    registerRoot(root) {
      if (disposed) return () => {};
      roots.set(root, (roots.get(root) ?? 0) + 1);

      // Harvested synchronously rather than left to the observer: an
      // already-populated subtree produces no mutation records, and waiting for
      // one would leave the view's first paint unstyled.
      const existing = new Set<string>();
      harvestClasses(root, existing);
      if (existing.size > 0) ingest(existing, true);

      let released = false;
      return () => {
        // Idempotent: React may invoke a ref cleanup once, but a caller holding
        // the function has no such guarantee, and double-release would drop a
        // count belonging to somebody else's registration.
        if (released || disposed) return;
        released = true;
        const remaining = (roots.get(root) ?? 1) - 1;
        if (remaining > 0) {
          roots.set(root, remaining);
          return;
        }
        roots.delete(root);
        // A departing root is the moment dead classes actually appear — a hot
        // reload swaps one generation's DOM for the next — so it is a far more
        // precise compaction trigger than watching the set grow. Growth alone
        // never fires for a generation that REPLACES classes rather than adding
        // to them, which is the common case.
        //
        // Deferred by a microtask because React detaches refs while the node is
        // still in the document: measured synchronously here, the departing
        // root's own classes still count as live and compaction decides there is
        // nothing to drop. `compact()` self-guards and returns before its
        // expensive half when that is genuinely true.
        queueMicrotask(() => {
          if (!disposed && compiled.size > compactionThreshold) void compact();
        });
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
