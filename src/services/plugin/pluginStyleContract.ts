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
import { PLUGIN_STYLE_OWNER_ATTRIBUTE } from "@/services/plugin/pluginStyleOwner";
import { logWarn } from "@/utils/logger";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import type {
  PluginStyleReport,
  PluginStyleRuntime,
} from "@/services/plugin/tailwind/pluginStyleRuntime";
import type { PluginCandidateValidator } from "@/services/plugin/tailwind/pluginTailwindAdapter";

const loadRuntimeModule = () => import("@/services/plugin/tailwind/pluginStyleRuntime");
const loadAdapterModule = () => import("@/services/plugin/tailwind/pluginTailwindAdapter");

/** Spreadable marker for the element a plugin view renders into. */
export const PLUGIN_STYLE_ROOT_PROPS: Readonly<Record<string, string>> = Object.freeze({
  [PLUGIN_STYLE_ROOT_ATTRIBUTE]: "",
});

export { PLUGIN_STYLE_OWNER_ATTRIBUTE };

/** {@link PLUGIN_STYLE_ROOT_PROPS} tagged with the owning plugin instance. */
export function pluginStyleRootPropsFor(pluginId: string): Readonly<Record<string, string>> {
  return Object.freeze({
    [PLUGIN_STYLE_ROOT_ATTRIBUTE]: "",
    [PLUGIN_STYLE_OWNER_ATTRIBUTE]: pluginId,
  });
}

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
    .then((module) =>
      module.createPluginStyleRuntime(document, {
        // Compaction rebuilds from live DOM, which necessarily forgets classes
        // that only ever came from a view's source text. Without dropping the
        // memo, a view that was prepared, unmounted and remounted would be
        // handed a resolved "already prepared" promise against a compiler that
        // no longer has its classes — and its first paint would be unstyled.
        onCompacted: () => preparedSources.clear(),
      })
    )
    .then((created) => {
      readyRuntime = created;
      return created;
    })
    .catch((error: unknown) => {
      // Left non-null so a failed load is not retried on every plugin mount;
      // the renderer would fail the same way each time.
      logWarn("[pluginStyleContract] Tailwind runtime unavailable; plugin views render unstyled", {
        error: formatErrorMessage(error, "unknown error"),
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

/**
 * Compiling the design system costs tens of milliseconds, so the validator is
 * built once per document and reused by every per-plugin check.
 */
let validatorPromise: Promise<PluginCandidateValidator> | null = null;

function candidateValidator(): Promise<PluginCandidateValidator> {
  validatorPromise ??= loadAdapterModule()
    .then((module) => module.createPluginCandidateValidator())
    .catch((error: unknown) => {
      // Not memoised on failure: a diagnostics read is user-initiated and
      // retryable, unlike the mount path above.
      validatorPromise = null;
      throw error;
    });
  return validatorPromise;
}

/**
 * Classify the classes currently on the given plugin roots — the per-plugin
 * form of {@link getPluginStyleReport}. The document-wide report cannot be
 * split by plugin because the runtime pools every plugin's classes, so the
 * caller picks the roots and this reads their live DOM. `null` when there are
 * no roots, which means "nothing mounted to check", not "every class was fine".
 */
export async function getPluginStyleReportForRoots(
  roots: readonly Element[]
): Promise<PluginStyleReport | null> {
  if (roots.length === 0) return null;
  const elementsByClass = new Map<string, Element[]>();
  const addClasses = (element: Element) => {
    const lucideIcon = element instanceof SVGElement && element.classList.contains("lucide");
    for (const token of element.classList) {
      // Lucide stamps `lucide` and `lucide-<icon>` on the icons it draws; the
      // same prefix on any other element is the author's and gets checked.
      if (lucideIcon && (token === "lucide" || token.startsWith("lucide-"))) continue;
      if (isMarkerClass(token)) continue;
      const elements = elementsByClass.get(token);
      if (elements) elements.push(element);
      else elementsByClass.set(token, [element]);
    }
  };
  for (const root of roots) {
    addClasses(root);
    for (const element of root.querySelectorAll("[class]")) addClasses(element);
  }
  // Kit components render host component classes (`search-field`,
  // `palette-row`, …) that the host's own stylesheet styles, not the plugin's
  // Tailwind. A class counts as styled by the host only where one of the
  // host's rules naming it actually selects the element carrying it, so a
  // plugin class that merely shares a name with a host class used elsewhere
  // (`.toolbar .status`) is still the author's to fix.
  const styled = classesStyledByDocument(roots[0]!.ownerDocument, elementsByClass);
  const generated: string[] = [];
  const candidates: string[] = [];
  for (const token of elementsByClass.keys()) {
    if (styled.has(token)) generated.push(token);
    else candidates.push(token);
  }
  const notGenerated: string[] = [];
  if (candidates.length > 0) {
    const validate = await candidateValidator();
    for (const verdict of validate(candidates)) {
      (verdict.generated ? generated : notGenerated).push(verdict.candidate);
    }
  }
  return { generated, notGenerated };
}

/** Tailwind's `group` / `peer` (optionally named) only anchor variants on other elements. */
function isMarkerClass(token: string): boolean {
  return /^(?:group|peer)(?:\/[\w-]+)?$/.test(token);
}

/**
 * The classes in `elementsByClass` that some document stylesheet rule applies
 * to on an element carrying them. Sheets are read afresh on every call: the
 * check runs only on demand, and constructed sheets are `replaceSync()`ed in
 * place, so no revision of a cached read would be trustworthy.
 */
function classesStyledByDocument(
  doc: Document,
  elementsByClass: ReadonlyMap<string, readonly Element[]>
): ReadonlySet<string> {
  const selectorsByClass = new Map<string, Set<string>>();
  for (const sheet of [...doc.styleSheets, ...(doc.adoptedStyleSheets ?? [])]) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      // A cross-origin sheet hides its rules; it cannot be the host's own CSS.
      continue;
    }
    collectClassSelectors(rules, null, elementsByClass, selectorsByClass);
  }
  const styled = new Set<string>();
  const verdicts = new Map<string, boolean>();
  for (const [name, selectors] of selectorsByClass) {
    const elements = elementsByClass.get(name)!;
    search: for (const selector of selectors) {
      for (const complex of splitSelectorList(selector)) {
        for (const prefix of prefixesThroughClass(complex, name)) {
          if (elements.some((element) => selectsElement(element, prefix, verdicts))) {
            styled.add(name);
            break search;
          }
        }
      }
    }
  }
  return styled;
}

const CLASS_SELECTOR = /\.((?:\\[0-9a-fA-F]{1,6}\s?|\\[^\n0-9a-fA-F]|[\w-])+)/g;
const CSS_ESCAPE = /\\(?:([0-9a-fA-F]{1,6})\s?|([^\n]))/g;

function unescapeClass(raw: string): string {
  return raw.replace(CSS_ESCAPE, (_, hex: string | undefined, char: string | undefined) =>
    hex ? String.fromCodePoint(parseInt(hex, 16)) : char!
  );
}

function collectClassSelectors(
  rules: CSSRuleList,
  parentSelector: string | null,
  wanted: ReadonlyMap<string, unknown>,
  out: Map<string, Set<string>>
): void {
  for (const rule of rules) {
    const selectorText = (rule as Partial<CSSStyleRule>).selectorText;
    let selector = parentSelector;
    if (typeof selectorText === "string") {
      selector =
        parentSelector === null ? selectorText : nestSelector(selectorText, parentSelector);
      for (const match of selector.matchAll(CLASS_SELECTOR)) {
        const name = unescapeClass(match[1]!);
        if (!wanted.has(name)) continue;
        let selectors = out.get(name);
        if (!selectors) out.set(name, (selectors = new Set()));
        selectors.add(selector);
      }
    }
    const nested = (rule as Partial<CSSGroupingRule>).cssRules;
    if (nested) collectClassSelectors(nested, selector, wanted, out);
  }
}

/** A nested style rule's selector, resolved against its parent's. */
function nestSelector(selector: string, parent: string): string {
  return selector.includes("&")
    ? selector.replaceAll("&", `:is(${parent})`)
    : `:is(${parent}) ${selector}`;
}

/** Split a selector list on its top-level commas. */
function splitSelectorList(selector: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < selector.length; i++) {
    const char = selector[i];
    if (char === "\\") i++;
    else if (char === "(" || char === "[") depth++;
    else if (char === ")" || char === "]") depth--;
    else if (char === "," && depth === 0) {
      parts.push(selector.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(selector.slice(start).trim());
  return parts.filter(Boolean);
}

/**
 * For each place `name` appears in a complex selector, the selector cut after
 * the compound that holds it: `.bar .status:hover > span` gives
 * `.bar .status:hover`. Whatever follows styles descendants or siblings, so the
 * class does its work if the element carrying it matches the part up to here.
 */
function prefixesThroughClass(complex: string, name: string): string[] {
  const prefixes: string[] = [];
  for (const match of complex.matchAll(CLASS_SELECTOR)) {
    if (unescapeClass(match[1]!) !== name) continue;
    let depth = 0;
    let inAttribute = false;
    for (let i = 0; i < match.index; i++) {
      const char = complex[i];
      if (char === "\\") i++;
      else if (inAttribute && (char === '"' || char === "'")) {
        // A quoted attribute value can hold `]`, `(` or `.name`; skip it whole.
        const close = complex.indexOf(char, i + 1);
        if (close === -1 || close >= match.index) break;
        i = close;
      } else if (char === "(" || char === "[") depth++;
      else if (char === ")" || char === "]") depth--;
      if (char === "[") inAttribute = true;
      else if (char === "]") inAttribute = false;
    }
    // `[data-kind=".status"]` is an attribute value, not the class.
    if (inAttribute) continue;
    let end = match.index + match[0].length;
    for (; end < complex.length; end++) {
      const char = complex[end]!;
      if (char === "\\") end++;
      else if (char === '"' || char === "'") {
        const close = complex.indexOf(char, end + 1);
        end = close === -1 ? complex.length : close;
      } else if (char === "(" || char === "[") depth++;
      else if (char === ")" || char === "]") depth--;
      else if (depth <= 0 && /[\s>+~]/.test(char)) break;
    }
    prefixes.push(complex.slice(0, end));
  }
  return prefixes;
}

// Pseudo-elements never match an element, and these states are ones the
// element passes in and out of; the rule still styles it in that state.
const PSEUDO_ELEMENT =
  /(?<!\\)::?(?:before|after|first-line|first-letter|marker|placeholder|selection|backdrop|file-selector-button|-webkit-[\w-]+|-moz-[\w-]+)(?:\([^)]*\))?/g;
const TRANSIENT_STATE_NAMES =
  "hover|focus|focus-visible|focus-within|active|visited|target|checked|indeterminate|disabled|enabled|placeholder-shown|open|popover-open|autofill|invalid|valid|user-invalid|user-valid";
const TRANSIENT_STATE = new RegExp(`(?<!\\\\):(?:${TRANSIENT_STATE_NAMES})(?![\\w-])`, "g");
// A negated state (`:not(:hover)`) is equally a state the element passes
// through, so the whole negation goes rather than leaving an empty `:not()`.
const NEGATED_TRANSIENT_STATE = new RegExp(
  `(?<!\\\\):not\\(\\s*(?::(?:${TRANSIENT_STATE_NAMES})\\s*,?\\s*)+\\)`,
  "g"
);

function selectsElement(
  element: Element,
  selector: string,
  verdicts: Map<string, boolean>
): boolean {
  const relaxed = selector
    .replace(PSEUDO_ELEMENT, "")
    .replace(NEGATED_TRANSIENT_STATE, "")
    .replace(TRANSIENT_STATE, "")
    .trim();
  for (const candidate of relaxed === selector ? [selector] : [relaxed, selector]) {
    if (candidate === "" || verdicts.get(candidate) === false) continue;
    try {
      if (element.matches(candidate)) return true;
    } catch {
      // A selector this engine cannot parse (or one emptied by the relaxing
      // above) never counts; remember it so the next element skips it.
      verdicts.set(candidate, false);
    }
  }
  return false;
}

/** Test seam: drop the document's runtime and every memoised preparation. */
export function resetPluginStyleContractForTests(): void {
  readyRuntime?.dispose();
  readyRuntime = null;
  runtimePromise = null;
  validatorPromise = null;
  preparedSources.clear();
}
