import { refractor } from "refractor/core";
import type { Syntax } from "refractor/core";
import type { TokenNode } from "react-diff-view";
import bash from "refractor/bash";
import css from "refractor/css";
import javascript from "refractor/javascript";
import jsx from "refractor/jsx";
import json from "refractor/json";
import markdown from "refractor/markdown";
import tsx from "refractor/tsx";
import typescript from "refractor/typescript";

for (const lang of [bash, css, javascript, jsx, json, markdown, tsx, typescript]) {
  refractor.register(lang);
}

interface PrismToken {
  type: string;
  content: PrismContent;
  alias?: string | string[];
}
type PrismContent = string | PrismToken | Array<string | PrismToken>;

interface WrapEnv {
  attributes: Record<string, string>;
  classes: string[];
  content: TokenNode | TokenNode[];
  language: string;
  tag: string;
  type: string;
}

interface RefractorInternals {
  Token: { stringify: (value: PrismContent, language: string) => TokenNode | TokenNode[] };
  hooks: { all: Record<string, unknown[] | undefined> };
}

const FAST_STRINGIFY_MARKER = Symbol.for("daintree.refractor.fast-token-stringify");

/**
 * refractor's own `Token.stringify` funnels every highlighted token through
 * hastscript's `h('span.token.keyword', …)`, which re-parses that CSS selector
 * with a regex for each of the tens of thousands of tokens a review-sized diff
 * produces. Selector parsing plus the hast element construction it drives was
 * ~28% of tokenize CPU (and a large share of its GC churn) in the PERF-160..162
 * profiles, for a node shape that is fully determined by the token: a `span`
 * whose className is `['token', type, ...aliases]`.
 *
 * This builds that node directly and only falls back to refractor's path when a
 * `wrap` hook actually contributed attributes (Prism's markup grammar sets a
 * `title` on entity tokens), so the emitted tree stays byte-for-byte identical.
 *
 * Note the blast radius: `refractor.Token` IS `Prism.Token` (refractor's core
 * does `Refractor.prototype = Prism`), so importing this module re-points token
 * stringification for every refractor consumer in the renderer — MarkdownDocument
 * included — which is why the equivalence has to hold for all languages, not
 * just the diff viewer's.
 */
/**
 * Mirrors hastscript's `addChild`: flattens nested arrays, unwraps `root`
 * nodes, and turns bare strings/numbers into text nodes. Only the hook path
 * needs it — a `wrap` hook may hand back any of those shapes.
 */
function appendChild(nodes: TokenNode[], value: unknown): void {
  if (value === null || value === undefined) return;
  if (typeof value === "number" || typeof value === "string") {
    nodes.push({ type: "text", value: String(value) } as TokenNode);
    return;
  }
  if (Array.isArray(value)) {
    for (const child of value) appendChild(nodes, child);
    return;
  }
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- hook-returned content is untyped hast
  const node = value as TokenNode & { type?: string; children?: TokenNode[] };
  if (node.type === "root") {
    appendChild(nodes, node.children);
    return;
  }
  nodes.push(node);
}

function flattenChild(value: unknown): TokenNode[] {
  const nodes: TokenNode[] = [];
  appendChild(nodes, value);
  return nodes;
}

function isEmptyRecord(record: Record<string, string>): boolean {
  for (const key in record) {
    if (Object.hasOwn(record, key)) return false;
  }
  return true;
}

function installFastTokenStringify(): void {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- reaching into refractor's Prism internals, pinned by the patched-vs-original differential in diffRefractorStringify.test.ts
  const internals = refractor as unknown as RefractorInternals;
  const tokenApi = internals.Token as RefractorInternals["Token"] & Record<symbol, unknown>;
  if (tokenApi[FAST_STRINGIFY_MARKER] === true) return;
  const original = tokenApi.stringify;

  const toNodes = (value: PrismContent, language: string, out: TokenNode[]): void => {
    if (typeof value === "string") {
      out.push({ type: "text", value });
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (entry !== null && entry !== undefined && entry !== "") {
          toNodes(entry, language, out);
        }
      }
      return;
    }

    const classes = ["token", value.type];
    if (value.alias) {
      if (typeof value.alias === "string") classes.push(value.alias);
      else classes.push(...value.alias);
    }

    const children: TokenNode[] = [];
    toNodes(value.content, language, children);

    const wrapHooks = internals.hooks.all["wrap"];
    if (wrapHooks !== undefined && wrapHooks.length > 0) {
      // Mirrors refractor: content is an array only when the token's own
      // content was one. Grammar hooks rely on that (markdown's code-block
      // hook reads `env.content.value` off the lone text node).
      const content = Array.isArray(value.content) ? children : children[0]!;
      const env: WrapEnv = {
        attributes: {},
        classes,
        content,
        language,
        tag: "span",
        type: value.type,
      };
      for (let i = 0; i < wrapHooks.length; i += 1) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Prism hook callbacks are untyped
        (wrapHooks[i] as (hookEnv: WrapEnv) => void)(env);
      }
      if (env.tag !== "span" || env.classes.length === 0 || !isEmptyRecord(env.attributes)) {
        // A hook rewrote the element shape or added attributes — hand this
        // token back to refractor so its entity decoding and hast property
        // normalisation stay authoritative.
        const restored = original.call(internals.Token, value, language);
        if (Array.isArray(restored)) out.push(...restored);
        else out.push(restored);
        return;
      }
      out.push({
        type: "element",
        tagName: "span",
        properties: { className: env.classes },
        // Untouched content is already a flat node list; only a hook that
        // swapped it in needs hastscript's array/root flattening.
        children: env.content === content ? children : flattenChild(env.content),
      } as TokenNode);
      return;
    }

    out.push({
      type: "element",
      tagName: "span",
      properties: { className: classes },
      children,
    } as TokenNode);
  };

  tokenApi.stringify = (value: PrismContent, language: string) => {
    if (typeof value === "string") return { type: "text", value } as TokenNode;
    const out: TokenNode[] = [];
    toNodes(value, language, out);
    return Array.isArray(value) ? out : out[0]!;
  };
  Object.defineProperty(tokenApi, FAST_STRINGIFY_MARKER, { value: true });
}

installFastTokenStringify();

/**
 * The tokenize pipeline expects refractor v3's highlight() contract — a plain
 * array of nodes. refractor v4+ returns a hast Root object, whose non-iterable
 * shape makes the token tree walk throw, which the catch in runDiffTokenize
 * silently turns into tokens = null: no syntax highlighting, no word-level
 * edit pills, no search marks. Unwrapping .children restores the v3 shape the
 * pipeline walks correctly.
 */
export const refractorAdapter = {
  highlight: (code: string, language: string): TokenNode[] =>
    refractor.highlight(code, language).children,
};

const LANG_LOADERS: Record<string, () => Promise<{ default: Syntax }>> = {
  c: () => import("refractor/c"),
  cpp: () => import("refractor/cpp"),
  csharp: () => import("refractor/csharp"),
  docker: () => import("refractor/docker"),
  go: () => import("refractor/go"),
  graphql: () => import("refractor/graphql"),
  java: () => import("refractor/java"),
  kotlin: () => import("refractor/kotlin"),
  less: () => import("refractor/less"),
  makefile: () => import("refractor/makefile"),
  markup: () => import("refractor/markup"),
  php: () => import("refractor/php"),
  python: () => import("refractor/python"),
  ruby: () => import("refractor/ruby"),
  rust: () => import("refractor/rust"),
  sass: () => import("refractor/sass"),
  scss: () => import("refractor/scss"),
  sql: () => import("refractor/sql"),
  swift: () => import("refractor/swift"),
  toml: () => import("refractor/toml"),
  yaml: () => import("refractor/yaml"),
};

const langLoadPromises = new Map<string, Promise<void>>();
const FAILED_LANGS = new Set<string>();

export function _resetLangStateForTests(): void {
  FAILED_LANGS.clear();
  langLoadPromises.clear();
}

/**
 * Test-only: await every in-flight grammar load so a rejected dynamic import
 * (and its `console.warn`) settles before the test file tears down. Without
 * this drain a late rejection can fire during vitest worker teardown, tripping
 * "Closing rpc while onUserConsoleLog was pending".
 */
export function _flushLangLoadsForTests(): Promise<unknown> {
  return Promise.allSettled([...langLoadPromises.values()]);
}

export function isLanguageRegistered(language: string): boolean {
  return refractor.registered(language);
}

export function isLanguageFailed(language: string): boolean {
  return FAILED_LANGS.has(language);
}

/**
 * Grammar failures in the worker happen in its own module instance; the client
 * mirrors them here so the renderer-side plaintext downgrade stays coherent.
 */
export function markLanguageFailed(language: string): void {
  FAILED_LANGS.add(language);
}

export function ensureLanguage(language: string): Promise<void> {
  if (refractor.registered(language)) return Promise.resolve();
  const loader = LANG_LOADERS[language];
  if (!loader) return Promise.resolve();
  let pending = langLoadPromises.get(language);
  if (!pending) {
    pending = loader()
      .then((mod) => {
        refractor.register(mod.default);
      })
      .catch((err: unknown) => {
        console.warn(`Failed to load refractor grammar for "${language}"`, err);
        FAILED_LANGS.add(language);
      });
    langLoadPromises.set(language, pending);
  }
  return pending;
}
