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
