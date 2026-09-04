/**
 * The host's entry point into the plugin styling contract.
 *
 * Deliberately tiny and eagerly importable. Everything expensive — the Tailwind
 * core, the design contract, the compiler — sits behind the module-scope
 * `loadRuntimeModule` below, so nothing here pulls ~277 KB of Tailwind into the
 * renderer's first-render chunk. The dynamic `import()` is hoisted to module
 * scope rather than written inline in a component for the same reason
 * `PluginViewContent.createLazyView` is: a raw `import()` inside a function body
 * bails React Compiler for that entire function.
 *
 * Failure here is never fatal. A plugin view that renders unstyled is a far
 * better outcome than one that refuses to render, so every step degrades to a
 * warning and lets the mount proceed.
 */

import { PLUGIN_STYLE_ROOT_ATTRIBUTE } from "@shared/types/plugin";
import { logWarn } from "@/utils/logger";
import type {
  PluginStyleReport,
  PluginStyleRuntime,
} from "@/services/plugin/tailwind/pluginStyleRuntime";

const loadRuntimeModule = () => import("@/services/plugin/tailwind/pluginStyleRuntime");

/** Spreadable marker for the element a plugin view renders into. */
export const PLUGIN_STYLE_ROOT_PROPS: Readonly<Record<string, string>> = Object.freeze({
  [PLUGIN_STYLE_ROOT_ATTRIBUTE]: "",
});

/**
 * How long the speculative source-text read may take before the mount stops
 * waiting on it. Short on purpose: this pass only buys first-paint styling, and
 * the DOM observer produces the same CSS a microtask later either way. A wedged
 * `plugin://` read must never be able to hold a panel open.
 */
const SOURCE_FETCH_TIMEOUT_MS = 2_000;

/**
 * Preparations to remember. Each plugin hot-reload generation mints a new
 * `__dtv-N` URL, so this map would otherwise grow for the length of a dev
 * session; the cap makes the worst case a repeated fetch rather than a leak.
 */
const MAX_REMEMBERED_SOURCES = 64;

/** One runtime per document, which is one per project `WebContentsView`. */
let runtimePromise: Promise<PluginStyleRuntime | null> | null = null;
let readyRuntime: PluginStyleRuntime | null = null;

/** Keyed by the full `plugin://…/__dtv-N/…` URL, so generations don't share. */
const preparedSources = new Map<string, Promise<void>>();

function runtime(): Promise<PluginStyleRuntime | null> {
  runtimePromise ??= loadRuntimeModule()
    .then((module) => module.createPluginStyleRuntime())
    .then((created) => {
      readyRuntime = created;
      return created;
    })
    .catch((error: unknown) => {
      // Left non-null so a failed load is not retried on every plugin mount;
      // the renderer would fail the same way each time.
      logWarn("[pluginStyleContract] Tailwind runtime unavailable; plugin views render unstyled", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    });
  return runtimePromise;
}

/**
 * Fetch and tokenise a view module's source so its classes are compiled before
 * it mounts. Best-effort: `plugin://` is a different origin from the host
 * document, and if a session ever declines the cross-origin read the DOM
 * observer still styles the view — one microtask later.
 */
async function ingestSourceText(service: PluginStyleRuntime, sourceUrl: string): Promise<void> {
  try {
    const response = await fetch(sourceUrl, {
      signal: AbortSignal.timeout(SOURCE_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return;
    service.addSourceText(await response.text());
  } catch {
    // Expected in any environment without the protocol (tests, a session that
    // never registered it). Silent by design: the observer is authoritative,
    // so this is an optimisation failing, not a fault.
  }
}

/**
 * Make the compiler ready, and pre-compile whatever classes the view's source
 * text mentions.
 *
 * Awaited inside the existing `lazy()` factory in `PluginViewContent`, alongside
 * plugin activation, so it rides the Suspense boundary, the import timeout and
 * the retry path already there — no new loading state and no second abort
 * mechanism. Deduped by URL, so simultaneous mounts of two panels of the same
 * kind prepare once.
 */
export function preparePluginStyles(sourceUrl: string): Promise<void> {
  const existing = preparedSources.get(sourceUrl);
  if (existing) return existing;

  const prepared = runtime().then(async (service) => {
    if (!service) return;
    await ingestSourceText(service, sourceUrl);
  });

  if (preparedSources.size >= MAX_REMEMBERED_SOURCES) {
    const oldest = preparedSources.keys().next();
    if (!oldest.done) preparedSources.delete(oldest.value);
  }
  preparedSources.set(sourceUrl, prepared);
  return prepared;
}

/**
 * Bring a mounted view's wrapper into the styling contract, and keep it there
 * as its subtree changes.
 *
 * Returns an unregister function suitable for an effect cleanup. Synchronous
 * because {@link preparePluginStyles} has already resolved by the time a view
 * commits; if it somehow has not, the root is simply not observed and its
 * classes are picked up when the next root registers.
 */
export function registerPluginStyleRoot(root: Element | null): () => void {
  if (!root || !readyRuntime) return () => {};
  return readyRuntime.registerRoot(root);
}

/**
 * Classify the classes seen in plugin DOM, for the validate and diagnostics
 * actions (#12214). `null` when no plugin view has ever mounted in this
 * document, which is different from "every class was fine".
 */
export function getPluginStyleReport(): Promise<PluginStyleReport | null> {
  return readyRuntime ? readyRuntime.getReport() : Promise.resolve(null);
}

/** Test seam: drop the document's runtime and every memoised preparation. */
export function resetPluginStyleContractForTests(): void {
  readyRuntime?.dispose();
  readyRuntime = null;
  runtimePromise = null;
  preparedSources.clear();
}
